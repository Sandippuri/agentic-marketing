/**
 * Shared OpenAI embedding helper. Extracted from find-similar so kb/* can
 * reuse the same model + dim contract without duplicating the call.
 *
 * Returns a 1536-dim vector for text-embedding-3-small. The KB stores these
 * in the existing `embeddings` table under source_type='kb_chunk'.
 */
import pino from "pino";

const log = pino({ name: "kb-embed" });

export const EMBED_MODEL = "text-embedding-3-small" as const;
export const EMBED_DIMS = 1536 as const;

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";

export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8_000) }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = json.data[0]?.embedding;
  if (!embedding?.length) throw new Error("empty embedding returned");
  return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  if (texts.length === 0) return [];

  const inputs = texts.map((t) => t.slice(0, 8_000));
  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
  // Provider returns objects keyed by `index` matching input order; sort to be safe.
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

export function vectorLiteral(vec: number[]): string {
  if (vec.length !== EMBED_DIMS) {
    log.warn({ got: vec.length, expected: EMBED_DIMS }, "vector dimension mismatch");
  }
  return `[${vec.join(",")}]`;
}
