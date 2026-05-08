import { eq } from "drizzle-orm";
import { getDb, schema, embeddings } from "@marketing/db";

// Phase 2 mirror of apps/distributor/src/embed-worker.ts. Each kind of embed
// is its own workflow run for clean retry semantics + observability. The
// existing /api/approvals route keeps calling enqueueEmbedding(...) — that
// helper now branches on WORKFLOW_EMBED to call start(...) instead of BullMQ.

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";

export type EmbedContentInput = { contentId: string };
export type EmbedRejectedDraftInput = { feedbackId: string };

// --- content embed ----------------------------------------------------------

export async function embedContentWorkflow(
  input: EmbedContentInput,
): Promise<{ embedded: boolean; reason?: string }> {
  "use workflow";
  const loaded = await loadContentForEmbedStep(input);
  if (!loaded.found) {
    return { embedded: false, reason: "not_found" };
  }
  const vector = await openaiEmbedStep(loaded.text);
  await upsertContentEmbeddingStep({
    contentId: input.contentId,
    text: loaded.text,
    vector,
  });
  return { embedded: true };
}

async function loadContentForEmbedStep(
  input: EmbedContentInput,
): Promise<
  { found: false } | { found: true; text: string }
> {
  "use step";
  const db = getDb();
  const [row] = await db
    .select({
      title: schema.contentItems.title,
      bodyMd: schema.contentItems.bodyMd,
    })
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, input.contentId))
    .limit(1);
  if (!row) return { found: false };
  const text = `${row.title}\n\n${row.bodyMd}`.slice(0, 8_000);
  return { found: true, text };
}

async function upsertContentEmbeddingStep(payload: {
  contentId: string;
  text: string;
  vector: number[];
}): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .insert(embeddings)
    .values({
      sourceType: "content",
      sourceId: payload.contentId,
      chunkIndex: 0,
      text: payload.text.slice(0, 2_000),
      embedding: payload.vector,
      metadata: { contentId: payload.contentId },
      model: MODEL,
    })
    .onConflictDoUpdate({
      target: [embeddings.sourceType, embeddings.sourceId, embeddings.chunkIndex],
      set: {
        text: payload.text.slice(0, 2_000),
        embedding: payload.vector,
        embeddedAt: new Date(),
        model: MODEL,
      },
    });
}

// --- rejected_draft embed ---------------------------------------------------

export async function embedRejectedDraftWorkflow(
  input: EmbedRejectedDraftInput,
): Promise<{ embedded: boolean; reason?: string }> {
  "use workflow";
  const loaded = await loadFeedbackForEmbedStep(input);
  if (!loaded.found) {
    return { embedded: false, reason: loaded.reason };
  }
  const vector = await openaiEmbedStep(loaded.text);
  await upsertRejectedEmbeddingStep({
    feedbackId: input.feedbackId,
    contentId: loaded.contentId,
    decision: loaded.decision,
    text: loaded.text,
    vector,
  });
  return { embedded: true };
}

async function loadFeedbackForEmbedStep(
  input: EmbedRejectedDraftInput,
): Promise<
  | { found: false; reason: "not_found" | "approved_skip" }
  | {
      found: true;
      text: string;
      contentId: string;
      decision: NonNullable<typeof schema.agentFeedback.$inferSelect.decision>;
    }
> {
  "use step";
  const db = getDb();
  const [fb] = await db
    .select({
      aiDraftMd: schema.agentFeedback.aiDraftMd,
      decision: schema.agentFeedback.decision,
      reason: schema.agentFeedback.reason,
      contentId: schema.agentFeedback.contentId,
    })
    .from(schema.agentFeedback)
    .where(eq(schema.agentFeedback.id, input.feedbackId))
    .limit(1);
  if (!fb) return { found: false, reason: "not_found" };
  if (fb.decision === "approved") return { found: false, reason: "approved_skip" };
  const text = (fb.reason ? `[reviewer reason] ${fb.reason}\n\n` : "")
    .concat(fb.aiDraftMd)
    .slice(0, 8_000);
  return {
    found: true,
    text,
    contentId: fb.contentId,
    decision: fb.decision,
  };
}

async function upsertRejectedEmbeddingStep(payload: {
  feedbackId: string;
  contentId: string;
  decision: string;
  text: string;
  vector: number[];
}): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .insert(embeddings)
    .values({
      sourceType: "rejected_draft",
      sourceId: payload.feedbackId,
      chunkIndex: 0,
      text: payload.text.slice(0, 2_000),
      embedding: payload.vector,
      metadata: {
        feedbackId: payload.feedbackId,
        contentId: payload.contentId,
        decision: payload.decision,
      },
      model: MODEL,
    })
    .onConflictDoUpdate({
      target: [embeddings.sourceType, embeddings.sourceId, embeddings.chunkIndex],
      set: {
        text: payload.text.slice(0, 2_000),
        embedding: payload.vector,
        embeddedAt: new Date(),
        model: MODEL,
      },
    });
}

// --- shared OpenAI step -----------------------------------------------------

async function openaiEmbedStep(text: string): Promise<number[]> {
  "use step";
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }
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
  const vector = json.data[0]?.embedding;
  if (!vector?.length) throw new Error("empty embedding returned");
  return vector;
}
