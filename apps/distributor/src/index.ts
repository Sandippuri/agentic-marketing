import pino from "pino";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { CpClient } from "@marketing/cp-client";
import { runJob } from "./worker";
import { buildAdapters } from "./adapters";
import { buildMetricsQueue, startMetricsWorker } from "./metrics-cron";
import { buildEmbedQueue, startEmbedWorker, startEmbedHttpServer } from "./embed-worker";
import {
  buildOutcomesRollupQueue,
  scheduleNightlyRollup,
  startOutcomesRollupWorker,
} from "./outcomes-rollup";

const log = pino({ name: "distributor" });

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
const internalToken = process.env.INTERNAL_API_TOKEN ?? "";

if (!internalToken) {
  log.warn(
    "INTERNAL_API_TOKEN is unset; CP calls will be rejected. Pull from Doppler / .env.",
  );
}

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const cp = new CpClient({ baseUrl, internalToken });
const adapters = buildAdapters(cp);

export const publishQueue = new Queue("publish", { connection });

// Metrics-fetch queue declared before worker so it's in scope.
export const metricsQueue = buildMetricsQueue(connection);
startMetricsWorker(connection, cp, adapters);

// Embedding queue + HTTP server (POST /embed from Control Plane).
export const embedQueue = buildEmbedQueue(connection);
startEmbedWorker(connection);
startEmbedHttpServer(embedQueue, internalToken);

// Nightly outcomes rollup (aggregates raw metrics into pre-rolled windows).
const rollupQueue = buildOutcomesRollupQueue(connection);
startOutcomesRollupWorker(connection);
scheduleNightlyRollup(rollupQueue).catch((err) =>
  log.error({ err }, "failed to schedule nightly rollup"),
);

const worker = new Worker(
  "publish",
  async (job) => {
    log.info({ id: job.id, name: job.name, data: job.data }, "received job");
    return runJob(job, cp, adapters, metricsQueue);
  },
  { connection, concurrency: 4 },
);

worker.on("failed", (job, err) => {
  log.error({ id: job?.id, err: err.message }, "job failed");
});
worker.on("completed", (job) => {
  log.info({ id: job.id }, "job completed");
});

log.info({ redisUrl, baseUrl, channels: Object.keys(adapters) }, "distributor ready");
