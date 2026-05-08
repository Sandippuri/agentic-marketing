/**
 * findBrandGuidance — semantic search over brand/product/SOP/playbook docs.
 *
 * As of Phase 1 of the agentic-platform rebuild, this is a thin proxy over
 * the unified Knowledge Base (kbSearch) so all callers benefit from one
 * pgvector index, one ingest pipeline, and one admin UI.
 *
 * Public API is preserved for backwards compatibility:
 *   - returns BrandGuidanceResult[] with the existing { source, text,
 *     similarity } shape;
 *   - `source` formatted as "<collectionKind>/<documentSlug>" so the
 *     legacy "brand/voice.md", "sop/linkedin.md" style continues to read
 *     well in agent prompts.
 *
 * The legacy in-memory file cache (apps/manager/memory/{brand,channel-sops,
 * playbooks}/*.md) remains as a fallback path for environments that
 * haven't yet run the KB seed script. Once Phase 4 deletes apps/manager
 * the fallback can go away.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import pino from "pino";
import { kbSearch, type KbSearchHit } from "./kb";
import { embedText } from "./kb/embed-client";

const log = pino({ name: "brand-guidance" });

const MEMORY_ROOT = import.meta.dirname
  ? resolve(import.meta.dirname, "..", "memory")
  : "";

export type BrandGuidanceResult = {
  source: string;
  text: string;
  similarity: number;
};

export type FindBrandGuidanceOptions = {
  topic: string;
  limit?: number;
};

export async function findBrandGuidance(
  opts: FindBrandGuidanceOptions,
): Promise<BrandGuidanceResult[]> {
  const limit = opts.limit ?? 5;

  // Primary path: KB search.
  try {
    const hits = await kbSearch({
      query: opts.topic,
      collectionKinds: ["brand", "product", "sop", "playbook"],
      k: limit,
    });
    if (hits.length > 0) {
      return hits.map(toLegacyShape);
    }
    log.debug("kb returned no hits; falling back to file cache");
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "kb search failed; falling back to file cache",
    );
  }

  // Fallback: legacy in-memory file cache. Removed when apps/manager goes
  // away in Phase 4.
  return findBrandGuidanceFromFiles(opts);
}

function toLegacyShape(h: KbSearchHit): BrandGuidanceResult {
  return {
    source: `${h.collectionKind}/${h.documentSlug}`,
    text: h.body,
    similarity: h.similarity,
  };
}

// ---------- legacy fallback (file-based cache) -------------------------------

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

type CachedChunk = { source: string; text: string; embedding: number[] };
let cachedChunks: CachedChunk[] | null = null;
let lastLoadMs = 0;
const CACHE_TTL_MS = 5 * 60 * 1_000;

async function loadFileSources(): Promise<Array<{ path: string; label: string }>> {
  if (!MEMORY_ROOT) return [];
  const dirs = [
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
  const files = await loadFileSources();
  const pending: Array<{ source: string; text: string }> = [];
  for (const { path, label } of files) {
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const chunk of chunkMarkdown(content)) {
      pending.push({ source: label, text: chunk });
    }
  }
  if (pending.length === 0) return [];

  const results = await Promise.allSettled(
    pending.map(async ({ source, text }) => {
      const embedding = await embedText(text);
      return { source, text, embedding } satisfies CachedChunk;
    }),
  );
  const chunks: CachedChunk[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") chunks.push(r.value);
  }
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

async function findBrandGuidanceFromFiles(
  opts: FindBrandGuidanceOptions,
): Promise<BrandGuidanceResult[]> {
  const limit = opts.limit ?? 5;
  let chunks: CachedChunk[];
  let queryVec: number[];
  try {
    [chunks, queryVec] = await Promise.all([
      getChunks(),
      embedText(opts.topic),
    ]);
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "fallback embed error; returning empty",
    );
    return [];
  }
  if (chunks.length === 0) return [];

  return chunks
    .map((c) => ({ ...c, similarity: cosine(queryVec, c.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map(({ source, text, similarity }) => ({ source, text, similarity }));
}
