/**
 * market-store — fetch the structured "Market" context (primary country,
 * target regions, languages, primary channels) for a workspace from the
 * Control Plane. Paired with the free-form `market.context` brand_memory
 * slug to give the strategist the "Place" of the 4 Ps.
 *
 * Same pattern as brand-store: HTTP fetch + 5-min in-process TTL cache.
 * Agents never touch the DB directly to keep postgres out of the workflow
 * bundle (see commit c27e201).
 */

import pino from "pino";
import {
  EMPTY_WORKSPACE_MARKET_CONTEXT,
  type WorkspaceMarketContext,
} from "@marketing/shared-types";

const log = pino({ name: "market-store" });

const CACHE_TTL_MS = 5 * 60 * 1_000;
const GLOBAL_KEY = "__global__";

type CacheEntry = { value: WorkspaceMarketContext; loadedAt: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<WorkspaceMarketContext>>();

function key(workspaceId?: string | null): string {
  return workspaceId ?? GLOBAL_KEY;
}

async function fetchFromCp(
  workspaceId?: string | null,
): Promise<WorkspaceMarketContext> {
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const token = process.env.INTERNAL_API_TOKEN ?? "";
  if (!token) {
    log.warn("INTERNAL_API_TOKEN not set; returning empty market context");
    return EMPTY_WORKSPACE_MARKET_CONTEXT;
  }

  const headers: Record<string, string> = { "x-internal-token": token };
  if (workspaceId) headers["x-workspace-id"] = workspaceId;

  try {
    const res = await fetch(`${baseUrl}/api/workspace/market-context`, { headers });
    if (!res.ok) {
      log.warn(
        { status: res.status, workspaceId },
        "CP /api/workspace/market-context non-2xx; using empty",
      );
      return EMPTY_WORKSPACE_MARKET_CONTEXT;
    }
    const row = (await res.json()) as Partial<WorkspaceMarketContext>;
    return {
      primaryCountry: row.primaryCountry ?? null,
      targetRegions: row.targetRegions ?? [],
      languages: row.languages ?? [],
      primaryChannels: row.primaryChannels ?? [],
    };
  } catch (err) {
    log.warn(
      { err: (err as Error).message, workspaceId },
      "CP /api/workspace/market-context fetch failed; using empty",
    );
    return EMPTY_WORKSPACE_MARKET_CONTEXT;
  }
}

export async function getWorkspaceMarketContext(
  scope: { workspaceId?: string | null } = {},
): Promise<WorkspaceMarketContext> {
  const k = key(scope.workspaceId);
  const now = Date.now();
  const hit = cache.get(k);
  if (hit && now - hit.loadedAt < CACHE_TTL_MS) return hit.value;
  const existing = inflight.get(k);
  if (existing) return existing;
  const promise = fetchFromCp(scope.workspaceId)
    .then((value) => {
      cache.set(k, { value, loadedAt: Date.now() });
      return value;
    })
    .finally(() => {
      inflight.delete(k);
    });
  inflight.set(k, promise);
  return promise;
}

export function clearMarketContextCache(scope?: { workspaceId?: string | null }): void {
  if (scope === undefined) {
    cache.clear();
    return;
  }
  cache.delete(key(scope.workspaceId));
}

// Render the structured fields as a Markdown block for sub-agent prompts.
// Returns "" when nothing is set so the system prompt stays clean.
export function formatMarketBlock(ctx: WorkspaceMarketContext): string {
  const lines: string[] = [];
  if (ctx.primaryCountry) lines.push(`- Primary country: ${ctx.primaryCountry}`);
  if (ctx.targetRegions.length > 0)
    lines.push(`- Target regions: ${ctx.targetRegions.join(", ")}`);
  if (ctx.languages.length > 0)
    lines.push(`- Languages: ${ctx.languages.join(", ")}`);
  if (ctx.primaryChannels.length > 0)
    lines.push(`- Primary channels: ${ctx.primaryChannels.join(", ")}`);
  if (lines.length === 0) return "";
  return `# Market\n\n${lines.join("\n")}`;
}
