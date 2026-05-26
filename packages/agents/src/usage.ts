// Per-call AI usage recorder.
//
// Wrap every LLM / embedding / image / video provider call in a
// `recordAiUsage` so cost dashboards stay complete. `recordLlmUsage` is
// kept as a thin convenience for LLM call sites (which are the majority
// and don't need to think about kind/units).
//
// Failures here MUST never propagate — observability shouldn't take the
// agent down. Errors are logged and swallowed.

import pino from "pino";
import { getDb, schema, type Database } from "@marketing/db";
import {
  computeLlmCostUsd,
  computeImageCostUsd,
  computeVideoCostUsd,
  computeEmbeddingCostUsd,
  getModelInfo,
  getImageModelInfo,
  getVideoModelInfo,
  type LlmModel,
  type ImageModel,
  type VideoModel,
} from "@marketing/shared-types";
import { loadAiPricing } from "./pricing";

const log = pino({ name: "ai-usage" });

export type AiSdkUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type UsageKind = "llm" | "embedding" | "image" | "video";

/**
 * Attribution fields that every recorded row needs. Pulled out into its own
 * type so image/video/embed call sites can pass a single opaque
 * `attribution` object through long call chains without retyping the
 * workspaceId/threadRef/jobId/workflowRunId quartet at each level.
 */
export type UsageAttribution = {
  agent: string;
  workspaceId: string;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

export type RecordUsageInput = {
  agent: string;
  /** Workspace scope; required from PR 5 — every ai_usage row is tenant-attributed. */
  workspaceId: string;
  model?: LlmModel;
  threadRef?: string | null;
  /** generation_jobs.id when the call ran under a GenerationTracker. */
  jobId?: string | null;
  /** workflow_runs.id when the call ran under any workflow engine. */
  workflowRunId?: string | null;
  usage?: AiSdkUsage;
  /** ai-sdk experimental_providerMetadata, used for cache-token extraction. */
  providerMetadata?: Record<string, unknown>;
  error?: string | null;
};

// Share the singleton pool from @marketing/db. Previously this kept its own
// `cachedDb` from a separate createDb() call, which meant the llm-usage
// recorder ran on a second 10-slot pool — a major contributor to
// max_connections exhaustion in dev.
function getLazyDb(): Database | null {
  if (!process.env.DATABASE_URL) return null;
  try {
    return getDb();
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "getDb failed; usage recording disabled",
    );
    return null;
  }
}

type AnthropicCacheMeta = {
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

function extractCacheTokens(meta: Record<string, unknown> | undefined): {
  read: number;
  creation: number;
} {
  if (!meta) return { read: 0, creation: 0 };
  const anthropic = meta.anthropic as AnthropicCacheMeta | undefined;
  if (!anthropic) return { read: 0, creation: 0 };
  return {
    read:
      typeof anthropic.cacheReadInputTokens === "number"
        ? anthropic.cacheReadInputTokens
        : 0,
    creation:
      typeof anthropic.cacheCreationInputTokens === "number"
        ? anthropic.cacheCreationInputTokens
        : 0,
  };
}

/**
 * Convenience for LLM call sites. Identical shape to the legacy
 * recordLlmUsage signature so existing callers don't change.
 */
export async function recordLlmUsage(input: RecordUsageInput): Promise<void> {
  const db = getLazyDb();
  if (!db) return;

  const modelId = input.model ?? "unknown";
  const info = getModelInfo(modelId);
  const provider = info?.provider ?? "unknown";
  const inputTokens = input.usage?.promptTokens ?? 0;
  const outputTokens = input.usage?.completionTokens ?? 0;
  const { read: cachedInputTokens, creation: cacheCreationTokens } =
    extractCacheTokens(input.providerMetadata);
  const totalTokens =
    input.usage?.totalTokens ?? inputTokens + outputTokens;

  const pricing = await loadAiPricing();
  const costUsd = computeLlmCostUsd(
    modelId,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    pricing.llm,
  );

  try {
    await db.insert(schema.aiUsage).values({
      workspaceId: input.workspaceId,
      kind: "llm",
      units: "tokens",
      provider,
      model: modelId,
      agent: input.agent,
      threadRef: input.threadRef ?? null,
      jobId: input.jobId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      totalTokens,
      unitCountInput: inputTokens,
      unitCountOutput: outputTokens,
      costUsd: costUsd != null ? costUsd.toFixed(6) : null,
      metadata: input.providerMetadata ?? {},
      error: input.error ?? null,
    });
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agent: input.agent, model: modelId },
      "failed to record llm usage",
    );
  }
}

// ---------------------------------------------------------------------------
// Image / Video / Embedding recorders.
//
// Each takes an optional `attribution` so call sites that don't have a
// workspaceId in scope (one-off scripts, backfills run outside any tenant
// context) can skip recording gracefully — we'd rather drop the row than
// invent a workspace id.

export type RecordImageInput = {
  attribution?: UsageAttribution;
  model: ImageModel;
  /** Number of images returned. Defaults to 1 (all current providers return one). */
  count?: number;
  error?: string | null;
  /** Free-form provider extras (aspect, predictionId, mimeType). */
  metadata?: Record<string, unknown>;
};

export async function recordImageUsage(input: RecordImageInput): Promise<void> {
  const a = input.attribution;
  if (!a?.workspaceId) return;
  const db = getLazyDb();
  if (!db) return;

  const provider = getImageModelInfo(input.model)?.provider ?? "unknown";
  const count = input.count ?? 1;
  const pricing = await loadAiPricing();
  const costUsd = computeImageCostUsd(input.model, count, pricing.image);

  try {
    await db.insert(schema.aiUsage).values({
      workspaceId: a.workspaceId,
      kind: "image",
      units: "images",
      provider,
      model: input.model,
      agent: a.agent,
      threadRef: a.threadRef ?? null,
      jobId: a.jobId ?? null,
      workflowRunId: a.workflowRunId ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      unitCountInput: 0,
      unitCountOutput: count,
      costUsd: costUsd != null ? costUsd.toFixed(6) : null,
      metadata: input.metadata ?? {},
      error: input.error ?? null,
    });
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agent: a.agent, model: input.model },
      "failed to record image usage",
    );
  }
}

export type RecordVideoInput = {
  attribution?: UsageAttribution;
  model: VideoModel;
  /** Duration of the produced clip in seconds. */
  durationSec: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordVideoUsage(input: RecordVideoInput): Promise<void> {
  const a = input.attribution;
  if (!a?.workspaceId) return;
  const db = getLazyDb();
  if (!db) return;

  const provider = getVideoModelInfo(input.model)?.provider ?? "unknown";
  const pricing = await loadAiPricing();
  const costUsd = computeVideoCostUsd(
    input.model,
    input.durationSec,
    pricing.video,
  );

  try {
    await db.insert(schema.aiUsage).values({
      workspaceId: a.workspaceId,
      kind: "video",
      units: "seconds",
      provider,
      model: input.model,
      agent: a.agent,
      threadRef: a.threadRef ?? null,
      jobId: a.jobId ?? null,
      workflowRunId: a.workflowRunId ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      unitCountInput: 0,
      unitCountOutput: Math.round(input.durationSec),
      costUsd: costUsd != null ? costUsd.toFixed(6) : null,
      metadata: input.metadata ?? {},
      error: input.error ?? null,
    });
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agent: a.agent, model: input.model },
      "failed to record video usage",
    );
  }
}

export type RecordEmbeddingInput = {
  attribution?: UsageAttribution;
  provider: string;
  model: string;
  /**
   * Embed-input tokens. When the provider returns a usage block use that;
   * otherwise approximate as Σ ceil(chars/4) — embedding token counts are
   * close to chars/4 for English-language text.
   */
  inputTokens: number;
  /** Number of vectors produced — recorded for sanity checks. */
  vectorCount?: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordEmbeddingUsage(
  input: RecordEmbeddingInput,
): Promise<void> {
  const a = input.attribution;
  if (!a?.workspaceId) return;
  const db = getLazyDb();
  if (!db) return;

  const pricing = await loadAiPricing();
  const costUsd = computeEmbeddingCostUsd(
    input.model,
    input.inputTokens,
    pricing.embedding,
  );

  try {
    await db.insert(schema.aiUsage).values({
      workspaceId: a.workspaceId,
      kind: "embedding",
      units: "tokens",
      provider: input.provider,
      model: input.model,
      agent: a.agent,
      threadRef: a.threadRef ?? null,
      jobId: a.jobId ?? null,
      workflowRunId: a.workflowRunId ?? null,
      inputTokens: input.inputTokens,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: input.inputTokens,
      unitCountInput: input.inputTokens,
      unitCountOutput: input.vectorCount ?? 0,
      costUsd: costUsd != null ? costUsd.toFixed(6) : null,
      metadata: input.metadata ?? {},
      error: input.error ?? null,
    });
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agent: a.agent, model: input.model },
      "failed to record embedding usage",
    );
  }
}

/** Cheap token estimate for providers that don't return a usage block. */
export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
