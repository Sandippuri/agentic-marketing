/**
 * Nightly rollup: aggregate raw `metrics` rows into `outcomes` rows.
 * One row per content_id × channel × window (7d | 30d | 90d).
 * Idempotent — upserts using the unique index on (content_id, channel, window).
 *
 * Phase 11 Day 1.
 */

import { Queue, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";
import { getDb, schema, outcomes } from "@marketing/db";
import type { Channel } from "@marketing/shared-types";
import { eq, and, gte, sql } from "drizzle-orm";
import pino from "pino";

const log = pino({ name: "outcomes-rollup" });

const QUEUE_NAME = "outcomes-rollup";

type RollupJobData = {
  window: "7d" | "30d" | "90d";
  // ISO timestamp: only roll up metrics observed on or after this date
  since: string;
};

const WINDOWS: Array<{ window: "7d" | "30d" | "90d"; days: number }> = [
  { window: "7d", days: 7 },
  { window: "30d", days: 30 },
  { window: "90d", days: 90 },
];

export function buildOutcomesRollupQueue(connection: IORedis): Queue<RollupJobData> {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: { removeOnComplete: 30, removeOnFail: 100 },
  });
}

/**
 * Schedule nightly rollup jobs (called once at startup). BullMQ's
 * `repeat` option re-enqueues automatically so this is idempotent.
 */
export async function scheduleNightlyRollup(queue: Queue<RollupJobData>): Promise<void> {
  for (const { window, days } of WINDOWS) {
    await queue.add(
      `rollup:${window}`,
      { window, since: new Date(Date.now() - days * 86_400_000).toISOString() },
      {
        jobId: `rollup:${window}:recurring`,
        repeat: { pattern: "0 2 * * *" }, // 02:00 UTC every day
        removeOnComplete: 30,
        removeOnFail: 100,
      },
    );
  }
  log.info("nightly rollup jobs scheduled");
}

export function startOutcomesRollupWorker(connection: IORedis): Worker<RollupJobData> {
  const worker = new Worker<RollupJobData>(
    QUEUE_NAME,
    async (job: Job<RollupJobData>) => {
      const { window, since } = job.data;
      log.info({ window, since }, "running outcomes rollup");

      const db = getDb();
      const sinceDate = new Date(since);

      /**
       * Aggregate metrics for the given window.
       * Metrics schema: scope_type='content', scope_id=content_id, channel,
       * metric (one of: impressions | clicks | conversions), value.
       * CTR and engagement_rate are derived.
       */
      const rows = await db
        .select({
          contentId: schema.metrics.scopeId,
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
        .groupBy(schema.metrics.scopeId, schema.metrics.channel, schema.metrics.metric);

      // Pivot: group by content × channel and collect metric totals.
      type Pivot = {
        impressions: number;
        clicks: number;
        conversions: number;
      };
      const pivoted = new Map<string, Pivot>();
      for (const row of rows) {
        if (!row.channel) continue;
        const key = `${row.contentId}::${row.channel}`;
        if (!pivoted.has(key)) {
          pivoted.set(key, { impressions: 0, clicks: 0, conversions: 0 });
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
            contentId: contentId!,
            channel: channel as Channel,
            window,
            impressions: totals.impressions,
            clicks: totals.clicks,
            conversions: totals.conversions,
            ctr: String(ctr.toFixed(6)),
            engagementRate: String(engagementRate.toFixed(6)),
            computedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [outcomes.contentId, outcomes.channel, outcomes.window],
            set: {
              impressions: totals.impressions,
              clicks: totals.clicks,
              conversions: totals.conversions,
              ctr: String(ctr.toFixed(6)),
              engagementRate: String(engagementRate.toFixed(6)),
              computedAt: new Date(),
            },
          });
        upserted++;
      }

      log.info({ window, upserted }, "outcomes rollup complete");
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    log.error({ id: job?.id, err: err.message }, "outcomes rollup failed");
  });

  return worker;
}
