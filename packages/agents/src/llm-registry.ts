// Maps a model id from shared-types `LLM_MODELS` to a Vercel-AI-SDK
// language-model instance. Falls back to the Anthropic default if the id
// is unknown — `resolveLlmModel` already enforces that, but the lookup
// is double-checked here so a bad id can't crash the orchestrator.

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { LanguageModelV1, LanguageModelV1CallOptions } from "ai";
import {
  DEFAULT_LLM_MODEL,
  getModelInfo,
  type LlmModel,
} from "@marketing/shared-types";

// The Google provider only auto-detects GOOGLE_GENERATIVE_AI_API_KEY; users
// often have it stored as GEMINI_API_KEY (which is what Google's own dashboard
// hands you), so mirror it once at module load.
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

// Anthropic models that reject `temperature` outright (not just in thinking
// mode). ai@4.x defaults temperature to 0 even when callers omit it, so we
// strip it before the request leaves the SDK. Drop this list when we move to
// ai-sdk v5, which no longer injects the default.
const ANTHROPIC_NO_TEMPERATURE = new Set<string>(["claude-opus-4-7"]);

export function getLanguageModel(id?: LlmModel): LanguageModelV1 {
  const info = getModelInfo(id ?? DEFAULT_LLM_MODEL) ?? getModelInfo(DEFAULT_LLM_MODEL)!;
  switch (info.provider) {
    case "anthropic":
      return ANTHROPIC_NO_TEMPERATURE.has(info.id)
        ? stripTemperature(anthropic(info.id))
        : anthropic(info.id);
    case "openai":
      return openai(info.id);
    case "google":
      return google(info.id);
  }
}

function stripTemperature(model: LanguageModelV1): LanguageModelV1 {
  const drop = (opts: LanguageModelV1CallOptions): LanguageModelV1CallOptions =>
    opts.temperature == null ? opts : { ...opts, temperature: undefined };
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === "doGenerate") {
        return (opts: LanguageModelV1CallOptions) => target.doGenerate(drop(opts));
      }
      if (prop === "doStream") {
        return (opts: LanguageModelV1CallOptions) => target.doStream(drop(opts));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
