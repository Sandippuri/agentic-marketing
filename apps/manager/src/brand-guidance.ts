/**
 * findBrandGuidance — perform in-memory semantic search over brand Markdown
 * files (voice, ICP, positioning, visual, channel SOPs).
 *
 * Strategy:
 * 1. Load all *.md files from memory/brand/ and memory/channel-sops/.
 * 2. Chunk each file into paragraphs (~400 tokens each).
 * 3. On first call, embed all chunks with text-embedding-3-small and cache.
 * 4. Embed the query and rank cached chunks by cosine similarity.
 * 5. Return top-k with source filename + text.
 *
 * In-memory is appropriate here: brand docs are small (<10 KB total) and
 * stable. A full DB round-trip to embeddings table is overkill unless you
 * have hundreds of brand documents.
 *
 * Phase 11.1.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import pino from "pino";

const log = pino({ name: "brand-guidance" });

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";
const MEMORY_ROOT = resolve(import.meta.dirname, "..", "memory");

// ---------- types -------------------------------------------------------------

export type BrandGuidanceResult = {
  source: string;
  text: string;
  similarity: number;
};

// ---------- embedding helper --------------------------------------------------

async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, input: text.slice(0, 8_000) }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = json.data[0]?.embedding;
  if (!embedding?.length) throw new Error("empty embedding returned");
  return embedding;
}

// ---------- chunker -----------------------------------------------------------

function chunkMarkdown(text: string, targetChars = 600): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > targetChars && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

// ---------- cosine similarity -------------------------------------------------

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------- in-process cache -------------------------------------------------

type CachedChunk = {
  source: string;
  text: string;
  embedding: number[];
};

let cachedChunks: CachedChunk[] | null = null;
let lastLoadMs = 0;
const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes — pick up edits without restart

async function loadBrandDirs(): Promise<Array<{ path: string; label: string }>> {
  const dirs = [
    { dir: join(MEMORY_ROOT, "brand"), label: "brand" },
    { dir: join(MEMORY_ROOT, "channel-sops"), label: "channel-sops" },
    { dir: join(MEMORY_ROOT, "playbooks"), label: "playbooks" },
  ];

  const files: Array<{ path: string; label: string }> = [];
  for (const { dir, label } of dirs) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".md")) {
        files.push({ path: join(dir, name), label: `${label}/${basename(name)}` });
      }
    }
  }
  return files;
}

async function buildChunkCache(): Promise<CachedChunk[]> {
  const files = await loadBrandDirs();
  const pending: Array<{ source: string; text: string }> = [];

  for (const { path, label } of files) {
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch {
      log.warn({ path }, "could not read brand file");
      continue;
    }
    const chunks = chunkMarkdown(content);
    for (const chunk of chunks) {
      pending.push({ source: label, text: chunk });
    }
  }

  if (pending.length === 0) {
    log.warn("no brand doc chunks found; returning empty cache");
    return [];
  }

  log.info({ chunks: pending.length }, "embedding brand doc chunks");

  // Embed all chunks in parallel (they're few enough).
  const results = await Promise.allSettled(
    pending.map(async ({ source, text }) => {
      const embedding = await embedText(text);
      return { source, text, embedding } satisfies CachedChunk;
    }),
  );

  const chunks: CachedChunk[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      chunks.push(r.value);
    } else {
      log.warn({ reason: r.reason }, "chunk embed failed; skipping");
    }
  }

  log.info({ embedded: chunks.length }, "brand doc cache ready");
  return chunks;
}

async function getChunks(): Promise<CachedChunk[]> {
  const now = Date.now();
  if (cachedChunks !== null && now - lastLoadMs < CACHE_TTL_MS) {
    return cachedChunks;
  }
  cachedChunks = await buildChunkCache();
  lastLoadMs = now;
  return cachedChunks;
}

// ---------- public API --------------------------------------------------------

export type FindBrandGuidanceOptions = {
  topic: string;
  limit?: number;
};

export async function findBrandGuidance(
  opts: FindBrandGuidanceOptions,
): Promise<BrandGuidanceResult[]> {
  const limit = opts.limit ?? 5;

  let chunks: CachedChunk[];
  let queryVec: number[];

  try {
    [chunks, queryVec] = await Promise.all([getChunks(), embedText(opts.topic)]);
  } catch (err) {
    log.warn({ err: (err as Error).message }, "findBrandGuidance: embed error; returning empty");
    return [];
  }

  if (chunks.length === 0) return [];

  const scored = chunks
    .map((c) => ({ ...c, similarity: cosine(queryVec, c.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored.map(({ source, text, similarity }) => ({ source, text, similarity }));
}
