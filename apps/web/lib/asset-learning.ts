/**
 * Asset learning loop — Phase D.
 *
 * Bridges the Asset Judge's per-candidate scores (Phase D1, on assets table)
 * to the Outcomes table (Phase 11, post-publish performance). Outputs that
 * scored well AND performed well get promoted into a per-brand
 * `approved-assets` KB collection — the Art Director then references them
 * automatically on future runs via the existing visual_reference search.
 *
 * This module is intentionally pure: it returns rows and writes to the KB,
 * but doesn't decide WHEN to run. A nightly cron (Phase D4) is the expected
 * caller.
 */

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { ensureCollection, upsertDocument } from "@marketing/agents/kb";
import { getSignedAssetUrl } from "@/lib/supabase/storage";

/**
 * Defaults are conservative: only promote assets that the judge clearly
 * accepted (≥16/25, well above the 14 reject threshold) AND that hit a
 * non-trivial engagement floor. Tune via the nightly job's invocation.
 */
const DEFAULTS = {
  minJudgeTotal: 16,
  minEngagementRate: 0.03,
  window: "7d" as "7d" | "30d" | "90d",
  /** Cap how many candidates the join returns per run, regardless of date range. */
  limit: 50,
};

export type FindHighPerformingOpts = {
  minJudgeTotal?: number;
  minEngagementRate?: number;
  window?: "7d" | "30d" | "90d";
  /** Only consider assets created on/after this timestamp. */
  since?: Date;
  /** Optional campaign filter. */
  campaignId?: string;
  limit?: number;
};

export type HighPerformingAsset = {
  assetId: string;
  contentId: string;
  storagePath: string;
  kind: string;
  judgeTotal: number;
  judgeVerdict: string;
  engagementRate: number;
  ctr: number;
  impressions: number;
  channel: string;
  contentTitle: string;
  campaignId: string;
};

/**
 * Find assets that scored well AND performed well — the join the learning
 * loop runs nightly to decide what to promote into the KB.
 */
export async function findHighPerformingAssets(
  opts: FindHighPerformingOpts = {},
): Promise<HighPerformingAsset[]> {
  const minJudgeTotal = opts.minJudgeTotal ?? DEFAULTS.minJudgeTotal;
  const minEngagementRate = opts.minEngagementRate ?? DEFAULTS.minEngagementRate;
  const window = opts.window ?? DEFAULTS.window;
  const limit = opts.limit ?? DEFAULTS.limit;

  const db = getDb();
  const conditions = [
    eq(schema.assets.judgeVerdict, "accept"),
    isNotNull(schema.assets.judgeTotal),
    gte(schema.assets.judgeTotal, String(minJudgeTotal)),
    eq(schema.outcomes.window, window),
    gte(schema.outcomes.engagementRate, String(minEngagementRate)),
  ];
  if (opts.since) {
    conditions.push(gte(schema.assets.createdAt, opts.since));
  }
  if (opts.campaignId) {
    conditions.push(eq(schema.contentItems.campaignId, opts.campaignId));
  }

  const rows = await db
    .select({
      assetId: schema.assets.id,
      contentId: schema.assets.contentId,
      storagePath: schema.assets.storagePath,
      kind: schema.assets.kind,
      judgeTotal: schema.assets.judgeTotal,
      judgeVerdict: schema.assets.judgeVerdict,
      engagementRate: schema.outcomes.engagementRate,
      ctr: schema.outcomes.ctr,
      impressions: schema.outcomes.impressions,
      channel: schema.outcomes.channel,
      contentTitle: schema.contentItems.title,
      campaignId: schema.contentItems.campaignId,
    })
    .from(schema.assets)
    .innerJoin(
      schema.contentItems,
      eq(schema.assets.contentId, schema.contentItems.id),
    )
    .innerJoin(
      schema.outcomes,
      eq(schema.outcomes.contentId, schema.contentItems.id),
    )
    .where(and(...conditions))
    .orderBy(sql`${schema.assets.judgeTotal} DESC, ${schema.outcomes.engagementRate} DESC`)
    .limit(limit);

  return rows
    .filter((r): r is typeof r & { contentId: string } => Boolean(r.contentId))
    .map((r) => ({
      assetId: r.assetId,
      contentId: r.contentId,
      storagePath: r.storagePath,
      kind: r.kind,
      judgeTotal: Number(r.judgeTotal ?? 0),
      judgeVerdict: r.judgeVerdict ?? "accept",
      engagementRate: Number(r.engagementRate ?? 0),
      ctr: Number(r.ctr ?? 0),
      impressions: r.impressions,
      channel: r.channel,
      contentTitle: r.contentTitle,
      campaignId: r.campaignId,
    }));
}

/**
 * Per-campaign approved-assets collection slug. The Art Director already
 * filters by collectionKinds=["visual_reference"], so anything in here is
 * automatically pulled as a reference image on future runs.
 */
function approvedCollectionSlug(campaignId: string): string {
  return `approved-assets-${campaignId}`;
}

/**
 * Promote an asset into the KB so the Art Director can reference it on
 * future runs. Generates a long-lived signed URL (~30 days) for the metadata
 * — the cron re-runs the promotion job often enough that URL rotation is
 * handled by re-upsert, not by URL renewal hooks.
 */
export async function promoteAssetToKb(
  asset: HighPerformingAsset,
): Promise<{ documentId: string } | null> {
  const SIGNED_URL_TTL_SECS = 60 * 60 * 24 * 30; // 30 days
  let signedUrl: string;
  try {
    signedUrl = await getSignedAssetUrl(asset.storagePath, SIGNED_URL_TTL_SECS);
  } catch (err) {
    console.warn(
      `[asset-learning] failed to sign URL for asset=${asset.assetId}; skipping:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const collectionId = await ensureCollection({
    slug: approvedCollectionSlug(asset.campaignId),
    name: "Approved assets (auto-promoted)",
    kind: "visual_reference",
    scope: "campaign",
    campaignId: asset.campaignId,
    description:
      "Assets that the Judge accepted AND that performed well post-publish. Auto-populated by the asset-learning cron; the Art Director uses these as reference images on future runs.",
  });

  const slug = `asset-${asset.assetId}`;
  const summary = [
    `Post: ${asset.contentTitle}`,
    `Channel: ${asset.channel}`,
    `Judge total: ${asset.judgeTotal.toFixed(1)}/25`,
    `Engagement (${asset.engagementRate.toFixed(4)}) / CTR (${asset.ctr.toFixed(4)}) / Impressions (${asset.impressions})`,
  ].join("\n");

  const doc = await upsertDocument({
    collectionId,
    slug,
    title: `Approved: ${asset.contentTitle.slice(0, 80)}`,
    bodyMd: summary,
    source: "agent",
    sourceRef: asset.assetId,
    metadata: {
      image_url: signedUrl,
      storage_path: asset.storagePath,
      asset_id: asset.assetId,
      content_id: asset.contentId,
      kind: asset.kind,
      channel: asset.channel,
      judge_total: asset.judgeTotal,
      engagement_rate: asset.engagementRate,
      promoted_at: new Date().toISOString(),
    },
    status: "active",
  });

  return { documentId: doc.id };
}

/**
 * One-shot: find the high performers and promote them. Returns a summary of
 * what was promoted so the cron can log it.
 */
export async function runPromotionPass(
  opts: FindHighPerformingOpts = {},
): Promise<{
  considered: number;
  promoted: number;
  skipped: number;
  errors: number;
}> {
  const candidates = await findHighPerformingAssets(opts);
  let promoted = 0;
  let skipped = 0;
  let errors = 0;
  for (const c of candidates) {
    try {
      const result = await promoteAssetToKb(c);
      if (result) promoted++;
      else skipped++;
    } catch (err) {
      errors++;
      console.warn(
        `[asset-learning] promotion failed for asset=${c.assetId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { considered: candidates.length, promoted, skipped, errors };
}
