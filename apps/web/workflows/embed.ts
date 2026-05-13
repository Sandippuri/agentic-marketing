import { eq } from "drizzle-orm";
import { getDb, schema, embeddings } from "@marketing/db";
import { embedText, getEmbeddingConfig } from "@marketing/agents/kb";

// Phase 2 mirror of apps/distributor/src/embed-worker.ts. Each kind of embed
// is its own workflow run for clean retry semantics + observability. The
// existing /api/approvals route keeps calling enqueueEmbedding(...) — that
// helper now branches on WORKFLOW_EMBED to call start(...) instead of BullMQ.
//
// Embedding provider/model is sourced from settings via embed-client; the
// model id is captured per call so each row gets tagged with the producer.

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
  const embed = await providerEmbedStep(loaded.text);
  await upsertContentEmbeddingStep({
    contentId: input.contentId,
    text: loaded.text,
    vector: embed.vector,
    model: embed.model,
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
  model: string;
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
      model: payload.model,
    })
    .onConflictDoUpdate({
      target: [embeddings.sourceType, embeddings.sourceId, embeddings.chunkIndex],
      set: {
        text: payload.text.slice(0, 2_000),
        embedding: payload.vector,
        embeddedAt: new Date(),
        model: payload.model,
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
  const embed = await providerEmbedStep(loaded.text);
  await upsertRejectedEmbeddingStep({
    feedbackId: input.feedbackId,
    contentId: loaded.contentId,
    decision: loaded.decision,
    text: loaded.text,
    vector: embed.vector,
    model: embed.model,
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
  model: string;
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
      model: payload.model,
    })
    .onConflictDoUpdate({
      target: [embeddings.sourceType, embeddings.sourceId, embeddings.chunkIndex],
      set: {
        text: payload.text.slice(0, 2_000),
        embedding: payload.vector,
        embeddedAt: new Date(),
        model: payload.model,
      },
    });
}

// --- shared embed step ------------------------------------------------------
// Calls the provider-agnostic embed-client, which dispatches to whichever
// provider is configured in settings (OpenAI / Gemini today).

async function providerEmbedStep(
  text: string,
): Promise<{ vector: number[]; model: string }> {
  "use step";
  const vector = await embedText(text);
  const { model } = await getEmbeddingConfig();
  return { vector, model };
}
