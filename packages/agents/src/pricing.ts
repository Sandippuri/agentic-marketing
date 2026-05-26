/**
 * DB-backed AI pricing loader.
 *
 * Pricing is sourced from settings(workspace_id IS NULL, key='ai_pricing').
 * That row is a partial overlay on top of DEFAULT_AI_PRICING (from
 * shared-types) — anything absent from the DB falls through to seed
 * defaults, so the migration that introduces this loader doesn't need to
 * seed every model up front.
 *
 * Loaded into an in-process cache with a 60s TTL to keep the hot path
 * (every recordAiUsage call) off the DB. Call `invalidatePricingCache()`
 * from any settings PATCH that touches `ai_pricing` so admins see updates
 * within the next request.
 *
 * Failure mode: any DB error falls back to seed defaults and logs a warning.
 * Cost recording must never crash an agent.
 */

import pino from "pino";
import { eq, and, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  DEFAULT_AI_PRICING,
  type AiPricingCatalog,
  type LlmPrice,
  type ImagePrice,
  type VideoPrice,
  type EmbeddingPrice,
} from "@marketing/shared-types";

const log = pino({ name: "ai-pricing" });

const CACHE_MS = 60_000;
let cached: { at: number; catalog: AiPricingCatalog } | null = null;

export const AI_PRICING_SETTINGS_KEY = "ai_pricing";

function mergeCatalog(override: Partial<AiPricingCatalog>): AiPricingCatalog {
  return {
    llm: { ...DEFAULT_AI_PRICING.llm, ...(override.llm ?? {}) } as Record<
      string,
      LlmPrice
    >,
    image: { ...DEFAULT_AI_PRICING.image, ...(override.image ?? {}) } as Record<
      string,
      ImagePrice
    >,
    video: { ...DEFAULT_AI_PRICING.video, ...(override.video ?? {}) } as Record<
      string,
      VideoPrice
    >,
    embedding: {
      ...DEFAULT_AI_PRICING.embedding,
      ...(override.embedding ?? {}),
    } as Record<string, EmbeddingPrice>,
  };
}

async function loadFromDb(): Promise<AiPricingCatalog> {
  if (!process.env.DATABASE_URL) return DEFAULT_AI_PRICING;
  try {
    const db = getDb();
    const rows = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          isNull(schema.settings.workspaceId),
          eq(schema.settings.key, AI_PRICING_SETTINGS_KEY),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || !row.value || typeof row.value !== "object") {
      return DEFAULT_AI_PRICING;
    }
    return mergeCatalog(row.value as Partial<AiPricingCatalog>);
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "ai_pricing settings read failed; using seed defaults",
    );
    return DEFAULT_AI_PRICING;
  }
}

export async function loadAiPricing(): Promise<AiPricingCatalog> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.catalog;
  const catalog = await loadFromDb();
  cached = { at: Date.now(), catalog };
  return catalog;
}

/** Reset the cached catalog. Call after a settings PATCH that touches `ai_pricing`. */
export function invalidatePricingCache(): void {
  cached = null;
}
