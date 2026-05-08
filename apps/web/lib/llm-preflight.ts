// Tiny "is the model usable right now" probe. Runs a 1-token generateText
// with retries disabled so a quota / auth / wrong-key issue surfaces in
// <1s with a classified result instead of a 25s mid-workflow failure.
//
// Successful pings cache for 5 minutes per model id; failures don't cache,
// so the next dispatch detects recovery immediately.

import { generateText, APICallError, RetryError } from "ai";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { getModelInfo, type LlmModel } from "@marketing/shared-types";

export type PreflightResult =
  | { ok: true }
  | {
      ok: false;
      provider: string;
      model: LlmModel;
      isQuota: boolean;
      isAuth: boolean;
      message: string;
    };

const successCache = new Map<string, number>();
const SUCCESS_TTL_MS = 5 * 60 * 1000;

export async function preflightModel(
  modelId: LlmModel,
): Promise<PreflightResult> {
  const info = getModelInfo(modelId);
  if (!info) {
    return {
      ok: false,
      provider: "unknown",
      model: modelId,
      isQuota: false,
      isAuth: false,
      message: `unknown model id: ${modelId}`,
    };
  }

  const cached = successCache.get(modelId);
  if (cached && Date.now() - cached < SUCCESS_TTL_MS) return { ok: true };

  try {
    await generateText({
      model: getLanguageModel(modelId),
      prompt: "ping",
      maxRetries: 0,
      // Reasoning models (gpt-5, o-series) consume internal reasoning tokens
      // before producing visible output, so a 1-token cap trips the model's
      // own "max_output_tokens reached" guard before any text comes back.
      // Give them enough headroom to finish reasoning + emit a single token.
      maxTokens: isReasoningModel(modelId) ? 256 : 1,
    });
    successCache.set(modelId, Date.now());
    return { ok: true };
  } catch (err) {
    return classify(err, info.provider, modelId);
  }
}

function isReasoningModel(modelId: string): boolean {
  return /^gpt-5(?:$|-)|^o\d/.test(modelId);
}

function classify(
  err: unknown,
  provider: string,
  model: LlmModel,
): Extract<PreflightResult, { ok: false }> {
  // With maxRetries:0 we usually still get an APICallError directly, but the
  // SDK occasionally wraps in RetryError(reason: errorNotRetryable) — unwrap
  // to reach the actual provider error.
  const inner = RetryError.isInstance(err)
    ? (err.lastError ?? err)
    : err;

  if (APICallError.isInstance(inner)) {
    const status = inner.statusCode ?? 0;
    const body = inner.responseBody ?? "";
    const isQuota =
      status === 429 &&
      /insufficient[_ ]quota|exceeded.*quota|billing/i.test(
        `${inner.message} ${body}`,
      );
    const isAuth = status === 401 || status === 403;
    return {
      ok: false,
      provider,
      model,
      isQuota,
      isAuth,
      message: shortMessage(inner.message, body, status),
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    provider,
    model,
    isQuota: /insufficient[_ ]quota|exceeded.*quota/i.test(message),
    isAuth: /unauthor|api[_ ]?key|forbidden/i.test(message),
    message,
  };
}

function shortMessage(msg: string, body: string, status: number): string {
  // The SDK's wrapping message is usually the most readable; only fall back
  // to parsing the body when it's a generic "Failed after N attempts" line.
  if (/Failed after.*attempts/i.test(msg) && body) {
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; code?: string };
      };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      // fall through
    }
    return `${status}: ${body.slice(0, 200)}`;
  }
  return msg;
}
