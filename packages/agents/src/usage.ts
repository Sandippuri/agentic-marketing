// Per-call LLM usage recorder.
//
// Wrap every generateText / generateObject result with `recordLlmUsage`.
// We accept the partial usage shape ai-sdk v4 returns ({ promptTokens,
// completionTokens, totalTokens }) plus optional providerMetadata so we
// can pull Anthropic prompt-cache counters when present.
//
// Failures here MUST never propagate — observability shouldn't take the
// agent down. Errors are logged and swallowed.

import pino from "pino";
import { createDb, schema } from "@marketing/db";
import {
  computeLlmCostUsd,
  getModelInfo,
  type LlmModel,
} from "@marketing/shared-types";

const log = pino({ name: "llm-usage" });

export type AiSdkUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type RecordUsageInput = {
  agent: string;
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

let cachedDb: ReturnType<typeof createDb> | null = null;
function getLazyDb() {
  if (cachedDb) return cachedDb;
  if (!process.env.DATABASE_URL) return null;
  try {
    cachedDb = createDb();
    return cachedDb;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "createDb failed; usage recording disabled");
    return null;
  }
}

function extractCachedTokens(meta: Record<string, unknown> | undefined): number {
  if (!meta) return 0;
  const anthropic = meta.anthropic as { cacheReadInputTokens?: number } | undefined;
  if (anthropic && typeof anthropic.cacheReadInputTokens === "number") {
    return anthropic.cacheReadInputTokens;
  }
  return 0;
}

export async function recordLlmUsage(input: RecordUsageInput): Promise<void> {
  const db = getLazyDb();
  if (!db) return;

  const modelId = input.model ?? "unknown";
  const info = getModelInfo(modelId);
  const provider = info?.provider ?? "unknown";
  const inputTokens = input.usage?.promptTokens ?? 0;
  const outputTokens = input.usage?.completionTokens ?? 0;
  const cachedInputTokens = extractCachedTokens(input.providerMetadata);
  const totalTokens =
    input.usage?.totalTokens ?? inputTokens + outputTokens;
  const costUsd = computeLlmCostUsd(modelId, inputTokens, outputTokens, cachedInputTokens);

  try {
    await db.insert(schema.llmUsage).values({
      provider,
      model: modelId,
      agent: input.agent,
      threadRef: input.threadRef ?? null,
      jobId: input.jobId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens,
      costUsd: costUsd != null ? costUsd.toFixed(6) : null,
      error: input.error ?? null,
    });
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agent: input.agent, model: modelId },
      "failed to record llm usage",
    );
  }
}
