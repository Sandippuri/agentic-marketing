/**
 * BullMQ worker that embeds approved content items using the OpenAI
 * text-embedding-3-small API and writes vectors to the generic `embeddings`
 * table (source_type='content').
 *
 * Also exposes a tiny HTTP endpoint (POST /embed) consumed by the Control Plane
 * via apps/web/lib/embedding-queue.ts.
 *
 * Phase 11 Day 2 / Phase 11.1 refactor.
 */

import { Queue, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";
import { getDb, schema, embeddings, contentEmbeddings } from "@marketing/db";
import { eq } from "drizzle-orm";
import pino from "pino";
import http from "node:http";

const log = pino({ name: "embed-worker" });

export type EmbedJobData = {
  contentId: string;
};

// ---------- shared embed helper -----------------------------------------------

export async function embedText(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, input: text }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = json.data[0]?.embedding;
  if (!embedding?.length) throw new Error("empty embedding returned");
  return embedding;
}

const QUEUE_NAME = "embed";
const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";

// ---------- queue factory -----------------------------------------------------

export function buildEmbedQueue(connection: IORedis): Queue<EmbedJobData> {
  return new Queue(QUEUE_NAME, { connection });
}

// ---------- HTTP server (POST /embed) -----------------------------------------

export function startEmbedHttpServer(
  queue: Queue<EmbedJobData>,
  internalToken: string,
  port = parseInt(process.env.EMBED_HTTP_PORT ?? "4002", 10),
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.url !== "/embed" || req.method !== "POST") {
      res.writeHead(404).end("not found");
      return;
    }
    if (req.headers["x-internal-token"] !== internalToken) {
      res.writeHead(401).end("unauthorized");
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { contentId } = JSON.parse(body) as { contentId: string };
        if (!contentId) throw new Error("missing contentId");

        await queue.add(
          `embed:${contentId}`,
          { contentId },
          { jobId: `embed:${contentId}`, removeOnComplete: 500, removeOnFail: 500 },
        );
        res.writeHead(202).end(JSON.stringify({ queued: true }));
      } catch (err) {
        log.error({ err }, "embed enqueue error");
        res.writeHead(400).end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  server.listen(port, () => {
    log.info({ port }, "embed http server listening");
  });

  return server;
}

// ---------- worker ------------------------------------------------------------

export function startEmbedWorker(connection: IORedis): Worker<EmbedJobData> {
  const apiKey = process.env.OPENAI_API_KEY ?? "";

  const worker = new Worker<EmbedJobData>(
    QUEUE_NAME,
    async (job: Job<EmbedJobData>) => {
      const { contentId } = job.data;

      if (!apiKey) {
        log.warn({ contentId }, "OPENAI_API_KEY not set; skipping embed");
        return;
      }

      const db = getDb();

      // Fetch the content body.
      const [content] = await db
        .select({ bodyMd: schema.contentItems.bodyMd, title: schema.contentItems.title })
        .from(schema.contentItems)
        .where(eq(schema.contentItems.id, contentId))
        .limit(1);

      if (!content) {
        log.warn({ contentId }, "content not found; skipping embed");
        return;
      }

      const text = `${content.title}\n\n${content.bodyMd}`.slice(0, 8_000);

      const embeddingVec = await embedText(text, apiKey);

      // Upsert into generic embeddings table (source_type='content').
      await db
        .insert(embeddings)
        .values({
          sourceType: "content",
          sourceId: contentId,
          chunkIndex: 0,
          text: text.slice(0, 2_000),
          embedding: embeddingVec,
          metadata: { contentId },
          model: MODEL,
        })
        .onConflictDoUpdate({
          target: [embeddings.sourceType, embeddings.sourceId, embeddings.chunkIndex],
          set: {
            text: text.slice(0, 2_000),
            embedding: embeddingVec,
            embeddedAt: new Date(),
            model: MODEL,
          },
        });

      // Also write to legacy content_embeddings for backward compat during
      // the migration window. Remove after 0002_generic_embeddings is applied
      // and DROP TABLE content_embeddings runs in staging.
      await db
        .insert(contentEmbeddings)
        .values({ contentId, embedding: embeddingVec, model: MODEL })
        .onConflictDoUpdate({
          target: contentEmbeddings.contentId,
          set: { embedding: embeddingVec, embeddedAt: new Date(), model: MODEL },
        })
        .catch(() => {
          // Silently ignore if content_embeddings was already dropped.
        });

      log.info({ contentId, dims: embeddingVec.length }, "embedded");
    },
    { connection, concurrency: 2 },
  );

  worker.on("failed", (job, err) => {
    log.error({ id: job?.id, err: err.message }, "embed job failed");
  });

  return worker;
}

// ---------- backfill helper ---------------------------------------------------

/**
 * Enqueue embedding jobs for all approved content items that don't yet have
 * an embedding. Run once with: node -e "require('./embed-worker').backfillEmbeds(queue)"
 */
export async function backfillEmbeds(queue: Queue<EmbedJobData>): Promise<void> {
  const db = getDb();

  // Find approved content items that don't yet have a row in `embeddings`.
  const rows = await db
    .select({ id: schema.contentItems.id })
    .from(schema.contentItems)
    .leftJoin(
      embeddings,
      eq(embeddings.sourceId, schema.contentItems.id),
    )
    .where(eq(schema.contentItems.status, "approved"));

  const missing = rows.filter((r) => !r.id);
  log.info({ total: rows.length, missing: missing.length }, "backfill scan");

  let enqueued = 0;
  for (const row of rows) {
    if (!row.id) continue;
    await queue.add(
      `embed:${row.id}`,
      { contentId: row.id },
      { jobId: `embed:${row.id}`, removeOnComplete: 500 },
    );
    enqueued++;
  }

  log.info({ enqueued }, "backfill enqueued");
}
