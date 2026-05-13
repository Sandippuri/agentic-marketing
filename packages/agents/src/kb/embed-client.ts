/**
 * Provider-agnostic embedding client. Dispatches to OpenAI or Gemini based on
 * the active config, which is sourced from (in priority order):
 *   1. process.env.EMBEDDING_PROVIDER + EMBEDDING_MODEL    (per-process override)
 *   2. settings.embedding_provider + settings.embedding_model (DB)
 *   3. DEFAULT_EMBEDDING_PROVIDER ("gemini")               (catalog fallback)
 *
 * The `embeddings.embedding` column is fixed at 1536 dims, so all providers
 * here either output 1536 natively or are asked to reduce. Voyage stays
 * stubbed until the schema is generalised.
 *
 * Stored vectors are tagged with the producing model id (`embeddings.model`),
 * which the read side filters on so vectors from different providers don't
 * get compared (different geometries → noise).
 */
import pino from "pino";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from "@marketing/shared-types";

const log = pino({ name: "kb-embed" });

export const EMBED_DIMS = 1536 as const;

const CACHE_MS = 60_000;
let cached: { at: number; config: EmbeddingConfig } | null = null;

async function loadConfig(): Promise<EmbeddingConfig> {
  // Per-process override wins. Useful for tests and one-off ops.
  const envProvider = process.env.EMBEDDING_PROVIDER;
  const envModel = process.env.EMBEDDING_MODEL;
  if (envProvider) {
    return resolveEmbeddingConfig({ provider: envProvider, model: envModel });
  }

  if (cached && Date.now() - cached.at < CACHE_MS) return cached.config;

  let provider: unknown;
  let model: unknown;
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.settings)
      .where(
        inArray(schema.settings.key, ["embedding_provider", "embedding_model"]),
      );
    for (const r of rows) {
      if (r.key === "embedding_provider") provider = r.value;
      if (r.key === "embedding_model") model = r.value;
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "could not read embedding settings; using defaults",
    );
  }

  const config = resolveEmbeddingConfig({ provider, model });
  cached = { at: Date.now(), config };
  return config;
}

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  return loadConfig();
}

/** Reset cached config. Call after a settings PATCH so the next embed picks up the change. */
export function invalidateEmbedConfigCache(): void {
  cached = null;
}

export async function embedText(text: string): Promise<number[]> {
  const config = await loadConfig();
  const [vec] = await dispatch(config, [text.slice(0, 8_000)]);
  if (!vec) throw new Error("empty embedding returned");
  return vec;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const config = await loadConfig();
  return dispatch(
    config,
    texts.map((t) => t.slice(0, 8_000)),
  );
}

async function dispatch(
  config: EmbeddingConfig,
  inputs: string[],
): Promise<number[][]> {
  switch (config.provider) {
    case "openai":
      return embedOpenAI(config.model, inputs);
    case "gemini":
      return embedGemini(config.model, inputs);
    case "voyage":
      throw new Error(
        `Voyage embedding provider is catalogued but not wired (model: ${config.model}). The 1536-dim DB column needs to be generalised first. Pick gemini or openai for now.`,
      );
  }
}

// --- OpenAI ----------------------------------------------------------------

async function embedOpenAI(
  model: string,
  inputs: string[],
): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const body: Record<string, unknown> = { model, input: inputs };
  // text-embedding-3-large is natively 3072d — ask the API to truncate to
  // our column width. text-embedding-3-small is already 1536d so the param
  // is harmless but explicit.
  if (model.startsWith("text-embedding-3-")) body.dimensions = EMBED_DIMS;

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };
  return [...json.data]
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// --- Gemini ----------------------------------------------------------------
// Uses :batchEmbedContents so a single HTTP roundtrip handles the batch path.
// outputDimensionality reduces the native 3072 down to 1536 to match the DB.

async function embedGemini(
  model: string,
  inputs: string[],
): Promise<number[][]> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: inputs.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIMS,
      })),
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini embed failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    embeddings: Array<{ values: number[] }>;
  };
  if (!Array.isArray(json.embeddings) || json.embeddings.length !== inputs.length) {
    throw new Error(
      `Gemini embed returned ${json.embeddings?.length ?? 0} vectors for ${inputs.length} inputs`,
    );
  }
  return json.embeddings.map((e) => e.values);
}

// --- Helpers ---------------------------------------------------------------

export function vectorLiteral(vec: number[]): string {
  if (vec.length !== EMBED_DIMS) {
    log.warn(
      { got: vec.length, expected: EMBED_DIMS },
      "vector dimension mismatch",
    );
  }
  return `[${vec.join(",")}]`;
}

// Re-exported so call sites that build their own settings reads can stay
// consistent with the resolver above without importing shared-types twice.
export { DEFAULT_EMBEDDING_PROVIDER, DEFAULT_EMBEDDING_MODEL };
