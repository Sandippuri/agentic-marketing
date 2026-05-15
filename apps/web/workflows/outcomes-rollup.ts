import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema, outcomes } from "@marketing/db";
import type { Channel } from "@marketing/shared-types";

// Phase 2 mirror of apps/distributor/src/outcomes-rollup.ts. Triggered by
// Vercel Cron (see app/api/cron/outcomes-rollup/route.ts). Aggregates raw
// metrics rows into `outcomes` rows, one per (content_id, channel, window).

const WINDOWS: Array<{ window: "7d" | "30d" | "90d"; days: number }> = [
  { window: "7d", days: 7 },
  { window: "30d", days: 30 },
  { window: "90d", days: 90 },
];

export async function outcomesRollupWorkflow(): Promise<{
  windows: Array<{ window: string; upserted: number }>;
}> {
  "use workflow";
  const results: Array<{ window: string; upserted: number }> = [];
  for (const w of WINDOWS) {
    const upserted = await rollupWindowStep({
      window: w.window,
      sinceISO: new Date(Date.now() - w.days * 86_400_000).toISOString(),
    });
    results.push({ window: w.window, upserted });
  }
  return { windows: results };
}

async function rollupWindowStep(input: {
  window: "7d" | "30d" | "90d";
  sinceISO: string;
}): Promise<number> {
  "use step";
  const db = getDb();
  const sinceDate = new Date(input.sinceISO);

  const rows = await db
    .select({
      contentId: schema.metrics.scopeId,
      workspaceId: schema.metrics.workspaceId,
      channel: schema.metrics.channel,
      metric: schema.metrics.metric,
      total: sql<string>`sum(${schema.metrics.value})`,
    })
    .from(schema.metrics)
    .where(
      and(
        eq(schema.metrics.scopeType, "content"),
        gte(schema.metrics.observedAt, sinceDate),
      ),
    )
    .groupBy(
      schema.metrics.scopeId,
      schema.metrics.workspaceId,
      schema.metrics.channel,
      schema.metrics.metric,
    );

  type Pivot = {
    workspaceId: string;
    impressions: number;
    clicks: number;
    conversions: number;
  };
  const pivoted = new Map<string, Pivot>();
  for (const row of rows) {
    if (!row.channel) continue;
    const key = `${row.contentId}::${row.channel}`;
    if (!pivoted.has(key)) {
      pivoted.set(key, {
        workspaceId: row.workspaceId,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      });
    }
    const p = pivoted.get(key)!;
    const val = parseFloat(row.total ?? "0");
    if (row.metric === "impressions") p.impressions += val;
    else if (row.metric === "clicks") p.clicks += val;
    else if (row.metric === "conversions") p.conversions += val;
  }

  let upserted = 0;
  for (const [key, totals] of pivoted) {
    const [contentId, channel] = key.split("::");
    const ctr =
      totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
    const engagementRate =
      totals.impressions > 0
        ? (totals.clicks + totals.conversions) / totals.impressions
        : 0;
    await db
      .insert(outcomes)
      .values({
        workspaceId: totals.workspaceId,
        contentId: contentId!,
        channel: channel as Channel,
        window: input.window,
        impressions: totals.impressions,
        clicks: totals.clicks,
        conversions: totals.conversions,
        ctr: ctr.toFixed(6),
        engagementRate: engagementRate.toFixed(6),
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [outcomes.contentId, outcomes.channel, outcomes.window],
        set: {
          impressions: totals.impressions,
          clicks: totals.clicks,
          conversions: totals.conversions,
          ctr: ctr.toFixed(6),
          engagementRate: engagementRate.toFixed(6),
          computedAt: new Date(),
        },
      });
    upserted++;
  }

  return upserted;
}
