// BullMQ repeatable job: 24 h after each email broadcast, pull open/click
// metrics from the email adapter and write them to the metrics table via CP.
// Phase 7 Day 4.

import { Queue, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";
import type { CpClient } from "@marketing/cp-client";
import type { Channel, PublishingAdapter } from "@marketing/shared-types";
import pino from "pino";

const log = pino({ name: "metrics-cron" });

export type MetricsFetchJobData = {
  publishJobId: string;
  contentId: string;
  channel: Channel;
  externalId: string;
};

const QUEUE_NAME = "metrics-fetch";

export function buildMetricsQueue(connection: IORedis): Queue<MetricsFetchJobData> {
  return new Queue(QUEUE_NAME, { connection });
}

/**
 * Schedule a metrics-fetch job 24 hours after a successful publish.
 * Called by runJob() when status transitions to "succeeded".
 */
export async function scheduleMetricsFetch(
  queue: Queue<MetricsFetchJobData>,
  data: MetricsFetchJobData,
): Promise<void> {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  await queue.add(`metrics:${data.publishJobId}`, data, {
    jobId: `metrics:${data.publishJobId}`,
    delay: TWENTY_FOUR_HOURS,
    removeOnComplete: 500,
    removeOnFail: 500,
  });
  log.debug({ publishJobId: data.publishJobId }, "metrics-fetch scheduled for 24h");
}

/**
 * Start the metrics-fetch worker. Each job calls the adapter's fetchMetrics()
 * and posts the results to the metrics table via cp-client.
 */
export function startMetricsWorker(
  connection: IORedis,
  cp: CpClient,
  adapters: Partial<Record<Channel, PublishingAdapter>>,
): Worker<MetricsFetchJobData> {
  const worker = new Worker<MetricsFetchJobData>(
    QUEUE_NAME,
    async (job: Job<MetricsFetchJobData>) => {
      const { publishJobId, channel, externalId } = job.data;
      const adapter = adapters[channel];
      if (!adapter?.fetchMetrics) {
        log.debug({ channel }, "no fetchMetrics for channel; skipping");
        return;
      }
      log.info({ publishJobId, channel }, "fetching metrics");
      const metrics = await adapter.fetchMetrics(externalId);

      // POST each metric value to the CP metrics endpoint.
      // Phase 8 will add a proper /api/metrics route; for now we log.
      log.info({ publishJobId, metrics }, "metrics fetched");

      // Post each scalar metric to the Control Plane.
      const entries = Object.entries(metrics).map(([metric, value]) => ({
        metric,
        value,
        channel,
        observedAt: new Date().toISOString(),
      }));
      if (entries.length > 0) {
        await cp.recordMetrics({
          scopeType: "content",
          scopeId: job.data.contentId,
          metrics: entries,
        });
        log.info({ publishJobId, count: entries.length }, "metrics recorded");
      }
    },
    { connection, concurrency: 2 },
  );

  worker.on("failed", (job, err) => {
    log.error({ id: job?.id, err: err.message }, "metrics-fetch job failed");
  });

  return worker;
}
