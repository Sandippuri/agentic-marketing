/**
 * design-system-store — fetch the structured brand design system (colors,
 * typography, logos with signed URLs, freeform tokens) from the Control
 * Plane API. Sister to brand-store.ts; same 5-minute TTL.
 *
 * Campaigns may carry their own design system. When a campaignId is
 * supplied, CP returns the campaign-scoped row if present, else the
 * global default. Campaign-scoped rows are full snapshots, not patches —
 * to override only colors, copy the global row first, then edit.
 *
 * The manager NEVER writes design tokens; that path is the admin UI only.
 */

import pino from "pino";
import {
  EMPTY_DESIGN_SYSTEM,
  type BrandDesignSystem,
  type DesignLogo,
} from "@marketing/shared-types";

const log = pino({ name: "design-system-store" });
const CACHE_TTL_MS = 5 * 60 * 1_000;
const GLOBAL_KEY = "__global__";

export type DesignSystemDoc = BrandDesignSystem & {
  // Logos as returned by CP — each carries a freshly-signed URL (1h TTL on
  // the CP side). We accept null when signing fails.
  logos: Array<DesignLogo & { signedUrl: string | null }>;
};

type CacheEntry = { doc: DesignSystemDoc; loadedAt: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<DesignSystemDoc>>();

function scopeKey(campaignId?: string | null): string {
  return campaignId ?? GLOBAL_KEY;
}

async function fetchFromCp(campaignId?: string | null): Promise<DesignSystemDoc | null> {
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const token = process.env.INTERNAL_API_TOKEN ?? "";
  if (!token) {
    log.warn("INTERNAL_API_TOKEN not set; design system unavailable");
    return null;
  }

  const url = new URL(`${baseUrl}/api/brand-design-system`);
  if (campaignId) url.searchParams.set("campaign_id", campaignId);

  try {
    const res = await fetch(url, {
      headers: { "x-internal-token": token },
    });
    if (!res.ok) {
      log.warn(
        { status: res.status, campaignId },
        "CP /api/brand-design-system non-2xx",
      );
      return null;
    }
    const json = (await res.json()) as DesignSystemDoc;
    return json;
  } catch (err) {
    log.warn(
      { err: (err as Error).message, campaignId },
      "CP /api/brand-design-system fetch failed",
    );
    return null;
  }
}

export async function getDesignSystem(
  campaignId?: string | null,
): Promise<DesignSystemDoc> {
  const key = scopeKey(campaignId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.loadedAt < CACHE_TTL_MS) return hit.doc;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const fromCp = await fetchFromCp(campaignId);
    return (
      fromCp ?? {
        ...EMPTY_DESIGN_SYSTEM,
        logos: EMPTY_DESIGN_SYSTEM.logos.map((l) => ({ ...l, signedUrl: null })),
      }
    );
  })()
    .then((doc) => {
      cache.set(key, { doc, loadedAt: Date.now() });
      return doc;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

// Format the design system as a compact human-readable block the asset
// sub-agent can consult before crafting an image-gen prompt. Hex codes are
// kept verbatim; the prompt above instructs the agent to copy them exactly.
export function formatDesignSystemForPrompt(doc: DesignSystemDoc): string {
  const lines: string[] = [];

  if (doc.colors.length > 0) {
    lines.push("Colors:");
    for (const c of doc.colors) {
      const role = c.role ? ` [${c.role}]` : "";
      const usage = c.usage ? ` — ${c.usage}` : "";
      lines.push(`  - ${c.name}: ${c.hex}${role}${usage}`);
    }
  }

  const t = doc.typography;
  if (t.headingFamily || t.bodyFamily || t.monoFamily || t.weights?.length || t.notes) {
    lines.push("");
    lines.push("Typography:");
    if (t.headingFamily) lines.push(`  - Heading: ${t.headingFamily}`);
    if (t.bodyFamily) lines.push(`  - Body: ${t.bodyFamily}`);
    if (t.monoFamily) lines.push(`  - Mono: ${t.monoFamily}`);
    if (t.weights?.length) lines.push(`  - Weights: ${t.weights.join(", ")}`);
    if (t.notes) lines.push(`  - Notes: ${t.notes}`);
  }

  if (doc.logos.length > 0) {
    lines.push("");
    lines.push("Logos (URLs are signed and expire ~1h):");
    for (const l of doc.logos) {
      const note = l.notes ? ` — ${l.notes}` : "";
      lines.push(`  - ${l.variant}: ${l.signedUrl ?? "(unavailable)"}${note}`);
    }
  }

  const tk = doc.tokens;
  const tokenEntries = [
    tk.spacing && `Spacing: ${tk.spacing}`,
    tk.radii && `Radii: ${tk.radii}`,
    tk.shadows && `Shadows: ${tk.shadows}`,
    tk.iconography && `Iconography: ${tk.iconography}`,
    tk.notes && `Notes: ${tk.notes}`,
  ].filter(Boolean);
  if (tokenEntries.length > 0) {
    lines.push("");
    lines.push("Other tokens:");
    for (const e of tokenEntries) lines.push(`  - ${e}`);
  }

  return lines.length > 0
    ? lines.join("\n")
    : "(design system not yet configured — fall back to brand.visual freeform doc)";
}

// For tests / forced refresh after admin save. Pass a campaignId to evict
// only that scope; omit to clear everything.
export function clearDesignSystemCache(campaignId?: string | null): void {
  if (campaignId === undefined) {
    cache.clear();
  } else {
    cache.delete(scopeKey(campaignId));
  }
}
