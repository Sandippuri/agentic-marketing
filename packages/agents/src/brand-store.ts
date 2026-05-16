/**
 * brand-store — fetch the brand-memory documents (voice, ICP, visual,
 * product state, positioning) from the Control Plane API. They used to live
 * as Markdown files in apps/manager/memory/{brand,product}/*.md and are now
 * editable from the admin UI.
 *
 * Campaigns may carry their own overrides. When a campaignId is supplied,
 * each slug resolves campaign-scoped row → global row → on-disk template.
 *
 * Read pattern:
 *   1. CP /api/brand-memory?campaign_id=<id?> (5-min in-process TTL per scope).
 *   2. If a row's body is empty AND we have a file copy on disk, the file
 *      content is used as the fallback body. (Disk fallback is global-only.)
 *   3. If the CP fetch fails entirely (network, internal token mismatch, CP
 *      not booted), we fall back to reading every slug from disk.
 *
 * The manager NEVER writes brand memory; that path is the admin UI only.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pino from "pino";
import {
  BRAND_MEMORY_SLUGS,
  BRAND_MEMORY_FILE_PATHS,
  BRAND_MEMORY_TITLES,
  type BrandMemorySlug,
} from "@marketing/shared-types";

const log = pino({ name: "brand-store" });

const MEMORY_ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..", "memory") : "";
const CACHE_TTL_MS = 5 * 60 * 1_000;
const GLOBAL_KEY = "__global__";

export type BrandMemoryDoc = {
  slug: BrandMemorySlug;
  title: string;
  body: string;
};

type CacheEntry = { docs: BrandMemoryDoc[]; loadedAt: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<BrandMemoryDoc[]>>();

function scopeKey(workspaceId?: string | null, campaignId?: string | null): string {
  return `${workspaceId ?? GLOBAL_KEY}::${campaignId ?? GLOBAL_KEY}`;
}

async function readFileFallback(slug: BrandMemorySlug): Promise<string> {
  try {
    return await readFile(join(MEMORY_ROOT, BRAND_MEMORY_FILE_PATHS[slug]), "utf8");
  } catch {
    return "";
  }
}

async function fetchFromCp(
  workspaceId?: string | null,
  campaignId?: string | null,
): Promise<BrandMemoryDoc[] | null> {
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const token = process.env.INTERNAL_API_TOKEN ?? "";
  if (!token) {
    log.warn("INTERNAL_API_TOKEN not set; falling back to file copies");
    return null;
  }

  const url = new URL(`${baseUrl}/api/brand-memory`);
  if (campaignId) url.searchParams.set("campaign_id", campaignId);

  const headers: Record<string, string> = { "x-internal-token": token };
  if (workspaceId) headers["x-workspace-id"] = workspaceId;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      log.warn({ status: res.status, workspaceId, campaignId }, "CP /api/brand-memory non-2xx; falling back");
      return null;
    }
    const rows = (await res.json()) as Array<{
      slug: BrandMemorySlug;
      title: string;
      body: string;
    }>;
    return rows.map((r) => ({ slug: r.slug, title: r.title, body: r.body }));
  } catch (err) {
    log.warn(
      { err: (err as Error).message, workspaceId, campaignId },
      "CP /api/brand-memory fetch failed; falling back",
    );
    return null;
  }
}

async function loadAll(
  workspaceId?: string | null,
  campaignId?: string | null,
): Promise<BrandMemoryDoc[]> {
  const fromCp = await fetchFromCp(workspaceId, campaignId);
  const docs: BrandMemoryDoc[] = [];
  // Disk fallback only makes sense for the legacy/global workspace —
  // tenant workspaces should never silently fall back to checked-in
  // brand text (that's user1's brand).
  const isGlobalScope = !campaignId && !workspaceId;

  for (const slug of BRAND_MEMORY_SLUGS) {
    const remote = fromCp?.find((d) => d.slug === slug);
    let body = remote?.body ?? "";
    // Empty body → only fall back to disk for global scope. Campaign-scoped
    // rows that are empty are an explicit "no override" signal, not a hole
    // we should fill from disk; the CP merge already returned the global
    // body in that case.
    if (!body.trim() && isGlobalScope) body = await readFileFallback(slug);
    docs.push({
      slug,
      title: remote?.title ?? BRAND_MEMORY_TITLES[slug],
      body,
    });
  }
  return docs;
}

export type BrandMemoryScope = {
  /** Workspace whose brand memory to load. Required for multi-tenant correctness. */
  workspaceId?: string | null;
  campaignId?: string | null;
};

export async function getBrandMemory(
  scope: BrandMemoryScope = {},
): Promise<BrandMemoryDoc[]> {
  const { workspaceId, campaignId } = scope;
  const key = scopeKey(workspaceId, campaignId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.loadedAt < CACHE_TTL_MS) return hit.docs;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = loadAll(workspaceId, campaignId)
    .then((docs) => {
      cache.set(key, { docs, loadedAt: Date.now() });
      return docs;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

export async function getBrandMemoryDoc(
  slug: BrandMemorySlug,
  scope: BrandMemoryScope = {},
): Promise<BrandMemoryDoc> {
  const all = await getBrandMemory(scope);
  const found = all.find((d) => d.slug === slug);
  if (found) return found;
  return { slug, title: BRAND_MEMORY_TITLES[slug], body: "" };
}

// For tests / forced refresh after admin save.
// - omit scope          → clear everything.
// - { workspaceId }     → clear ALL entries for that workspace (every
//                         campaign scope + the global fallback). This is
//                         what admin save calls so workflow runs see fresh
//                         brand data on the next tick.
// - { workspaceId, campaignId } → clear that exact key only.
export function clearBrandMemoryCache(scope?: BrandMemoryScope): void {
  if (scope === undefined) {
    cache.clear();
    return;
  }
  if (scope.campaignId !== undefined && scope.campaignId !== null) {
    cache.delete(scopeKey(scope.workspaceId, scope.campaignId));
    return;
  }
  const prefix = `${scope.workspaceId ?? GLOBAL_KEY}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
