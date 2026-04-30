import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { Channel } from "@marketing/shared-types";

// Best-effort enqueue: the DB row in publish_jobs is the source of truth.
// If Redis is down, the Distributor's poll fallback (Phase 5 Day 3) will
// still pick up queued rows on its next tick.

let queue: Queue | undefined;
let connection: IORedis | undefined;

function getQueue(): Queue | null {
  if (queue) return queue;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  connection = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  queue = new Queue("publish", { connection });
  return queue;
}

export type PublishJobMessage = {
  publishJobId: string;
  contentId: string;
  channel: Channel;
  threadRef?: string;
};

export async function enqueuePublish(
  msg: PublishJobMessage,
  opts?: { delayMs?: number },
): Promise<{ enqueued: boolean; reason?: string }> {
  const q = getQueue();
  if (!q) return { enqueued: false, reason: "REDIS_URL unset" };
  try {
    await q.add(`publish:${msg.channel}`, msg, {
      jobId: msg.publishJobId, // dedupe across retries
      delay: opts?.delayMs,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
    return { enqueued: true };
  } catch (err) {
    return {
      enqueued: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
