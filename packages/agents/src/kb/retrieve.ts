/**
 * Knowledge Base retrieval — hybrid (vector + BM25) with optional reranker
 * and parent-section expansion.
 *
 * Phase 7 upgrade. Same `kbSearch(opts)` API the rest of the codebase
 * already calls — additive options only.
 *
 * Pipeline per query:
 *   1. embed query → cosine search top-N (default N=25)
 *   2. tsvector BM25 search top-N (Postgres ts_rank_cd, normalisation=32)
 *   3. fuse with Reciprocal Rank Fusion (k=60); union of candidates
 *   4. optional reranker pass (Cohere if KB_RERANKER=cohere; else passthrough)
 *   5. optional section expansion: if expandToSection=true, group by
 *      (documentId, heading) and concat sibling chunks so the LLM gets a
 *      coherent unit instead of a 500-token slice
 */
import pino from "pino";
import { sql, eq, and, inArray } from "drizzle-orm";
import {
  getDb,
  schema,
  kbChunks,
  kbDocuments,
  kbCollections,
} from "@marketing/db";
import { embedText, getEmbeddingConfig, vectorLiteral } from "./embed-client";
import type { CollectionKind } from "./store";
import { rerank, resolveReranker } from "./rerank";

const log = pino({ name: "kb-retrieve" });

export type KbSearchHit = {
  chunkId: string;
  documentId: string;
  documentSlug: string;
  documentTitle: string;
  collectionId: string;
  collectionSlug: string;
  collectionName: string;
  collectionKind: CollectionKind;
  chunkIndex: number;
  body: string;
  similarity: number;
  metadata: Record<string, unknown>;
  documentMetadata: Record<string, unknown>;
  /** Only present when expandToSection=true and the chunk shares a heading with siblings. */
  expandedSection?: string;
};

export type KbSearchMode = "vector" | "bm25" | "hybrid";

export type KbSearchOptions = {
  query: string;
  collectionKinds?: CollectionKind[];
  collectionIds?: string[];
  campaignId?: string;
  /** Final result count returned to the caller. Default 6. */
  k?: number;
  /** Cosine similarity floor on the vector path. Default 0. */
  minSimilarity?: number;
  /** Retrieval strategy. Default 'hybrid'. */
  mode?: KbSearchMode;
  /** Pool size pulled from each path before fusion. Default 25. */
  candidatePool?: number;
  /** When true (default if KB_RERANKER set), pass top candidates through the reranker. */
  rerank?: boolean;
  /** When true, group result chunks by (documentId, heading) and expand to the full section. */
  expandToSection?: boolean;
};

const DEFAULT_K = 6;
const DEFAULT_POOL = 25;
const RRF_CONSTANT = 60;

export async function kbSearch(opts: KbSearchOptions): Promise<KbSearchHit[]> {
  if (!opts.query.trim()) return [];

  const mode = opts.mode ?? "hybrid";
  const k = opts.k ?? DEFAULT_K;
  const pool = opts.candidatePool ?? DEFAULT_POOL;
  const useRerank = opts.rerank ?? resolveReranker() !== "none";

  const filters = buildFilters(opts);

  const [vectorHits, bm25Hits] = await Promise.all([
    mode === "bm25" ? Promise.resolve<RankedRow[]>([]) : runVector(opts.query, pool, filters),
    mode === "vector" ? Promise.resolve<RankedRow[]>([]) : runBm25(opts.query, pool, filters),
  ]);

  const fused = fuseRRF(vectorHits, bm25Hits);
  if (fused.length === 0) return [];

  // Hydrate the candidate set with full chunk + doc metadata in a single
  // query so the reranker has body text to score against.
  const candidates = await hydrateChunks(fused.map((f) => f.chunkId));

  // Optional reranker.
  let ordered: KbSearchHit[];
  if (useRerank && candidates.length > 0) {
    const rerankResults = await rerank(
      opts.query,
      candidates.map((c) => ({ id: c.chunkId, text: c.body })),
      Math.min(candidates.length, k),
    );
    const byId = new Map(candidates.map((c) => [c.chunkId, c]));
    ordered = rerankResults
      .map((r) => {
        const hit = byId.get(r.id);
        return hit ? { ...hit, similarity: r.score } : null;
      })
      .filter((h): h is KbSearchHit => h !== null);
  } else {
    // Use the fused score as similarity proxy. Normalise to 0..1 over the
    // current result set so callers see a comparable number.
    const fuseById = new Map(fused.map((f) => [f.chunkId, f.score]));
    const top = candidates
      .map((c) => ({ ...c, similarity: fuseById.get(c.chunkId) ?? 0 }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
    const max = Math.max(...top.map((t) => t.similarity), 1);
    ordered = top.map((t) => ({ ...t, similarity: t.similarity / max }));
  }

  // Apply caller-provided minSimilarity floor (only meaningful in vector
  // mode; in hybrid the score is fused/normalised so callers usually leave
  // it at 0).
  if ((opts.minSimilarity ?? 0) > 0) {
    ordered = ordered.filter((h) => h.similarity >= opts.minSimilarity!);
  }

  if (opts.expandToSection) {
    ordered = await expandSections(ordered);
  }

  return ordered;
}

/**
 * Render a list of hits into a compact prompt-friendly block. Keeps the
 * provenance line short ("from <collection> · <doc>") so the LLM can cite.
 */
export function renderHitsForPrompt(hits: KbSearchHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h, i) => {
    const body = h.expandedSection ?? h.body;
    return `--- [${i + 1}] from ${h.collectionName} · ${h.documentTitle} (score ${h.similarity.toFixed(2)})\n${body.trim()}`;
  });
  return lines.join("\n\n");
}

// ============================================================
// Internals
// ============================================================

type RankedRow = { chunkId: string; rank: number; score: number };

type Filters = ReturnType<typeof buildFilters>;

function buildFilters(opts: KbSearchOptions) {
  const conds: ReturnType<typeof eq>[] = [eq(kbDocuments.status, "active")];
  if (opts.collectionKinds?.length) {
    conds.push(inArray(kbCollections.kind, opts.collectionKinds) as never);
  }
  if (opts.collectionIds?.length) {
    conds.push(inArray(kbDocuments.collectionId, opts.collectionIds) as never);
  }
  if (opts.campaignId) {
    conds.push(
      sql`(${kbCollections.campaignId} = ${opts.campaignId}::uuid OR ${kbCollections.scope} = 'global')` as never,
    );
  }
  return conds;
}

async function runVector(
  query: string,
  pool: number,
  filters: Filters,
): Promise<RankedRow[]> {
  let vector: number[];
  let model: string;
  try {
    vector = await embedText(query);
    model = (await getEmbeddingConfig()).model;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "kb embed failed; vector path empty");
    return [];
  }
  const lit = vectorLiteral(vector);
  const db = getDb();
  // Filter to vectors produced by the *current* model. Mixing across providers
  // gives garbage similarity (different geometries). Old rows become invisible
  // until re-embedded via the backfill route.
  const rows = await db
    .select({
      chunkId: kbChunks.id,
      distance: sql<number>`(${schema.embeddings.embedding} <=> ${sql.raw(`'${lit}'::vector`)})`,
    })
    .from(schema.embeddings)
    .innerJoin(
      kbChunks,
      sql`${schema.embeddings.sourceId} = ${kbChunks.id}::text`,
    )
    .innerJoin(kbDocuments, eq(kbChunks.documentId, kbDocuments.id))
    .innerJoin(kbCollections, eq(kbDocuments.collectionId, kbCollections.id))
    .where(
      and(
        eq(schema.embeddings.sourceType, "kb_chunk"),
        eq(schema.embeddings.model, model),
        ...filters,
      ),
    )
    .orderBy(
      sql`(${schema.embeddings.embedding} <=> ${sql.raw(`'${lit}'::vector`)})`,
    )
    .limit(pool);

  return rows.map((r, i) => ({
    chunkId: r.chunkId,
    rank: i,
    score: 1 - Number(r.distance),
  }));
}

async function runBm25(
  query: string,
  pool: number,
  filters: Filters,
): Promise<RankedRow[]> {
  const db = getDb();
  // plainto_tsquery is forgiving for natural-language queries; phrase / & /
  // operators can land later if needed. Normalisation 32: rank/(rank+1) so
  // scores stay in 0..1.
  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const rows = await db
    .select({
      chunkId: kbChunks.id,
      rank: sql<number>`ts_rank_cd(${sql.raw('"kb_chunks"."tsv"')}, ${tsQuery}, 32)::float8`,
    })
    .from(kbChunks)
    .innerJoin(kbDocuments, eq(kbChunks.documentId, kbDocuments.id))
    .innerJoin(kbCollections, eq(kbDocuments.collectionId, kbCollections.id))
    .where(
      and(
        sql`${sql.raw('"kb_chunks"."tsv"')} @@ ${tsQuery}`,
        ...filters,
      ),
    )
    .orderBy(sql`ts_rank_cd(${sql.raw('"kb_chunks"."tsv"')}, ${tsQuery}, 32) DESC`)
    .limit(pool);

  return rows.map((r, i) => ({
    chunkId: r.chunkId,
    rank: i,
    score: Number(r.rank),
  }));
}

/**
 * Reciprocal Rank Fusion. score(c) = sum over lists L of 1/(k + rank_L(c)).
 * k=60 is the standard. Robust to score-scale mismatches across rankers.
 */
function fuseRRF(...lists: RankedRow[][]): RankedRow[] {
  const sums = new Map<string, number>();
  for (const list of lists) {
    for (const row of list) {
      const prev = sums.get(row.chunkId) ?? 0;
      sums.set(row.chunkId, prev + 1 / (RRF_CONSTANT + row.rank + 1));
    }
  }
  return Array.from(sums.entries())
    .map(([chunkId, score], i) => ({ chunkId, rank: i, score }))
    .sort((a, b) => b.score - a.score);
}

async function hydrateChunks(chunkIds: string[]): Promise<KbSearchHit[]> {
  if (chunkIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      chunkId: kbChunks.id,
      documentId: kbDocuments.id,
      documentSlug: kbDocuments.slug,
      documentTitle: kbDocuments.title,
      documentMetadata: kbDocuments.metadata,
      collectionId: kbCollections.id,
      collectionSlug: kbCollections.slug,
      collectionName: kbCollections.name,
      collectionKind: kbCollections.kind,
      chunkIndex: kbChunks.chunkIndex,
      body: kbChunks.bodyMd,
      metadata: kbChunks.metadata,
    })
    .from(kbChunks)
    .innerJoin(kbDocuments, eq(kbChunks.documentId, kbDocuments.id))
    .innerJoin(kbCollections, eq(kbDocuments.collectionId, kbCollections.id))
    .where(inArray(kbChunks.id, chunkIds));

  return rows.map((r) => ({
    chunkId: r.chunkId,
    documentId: r.documentId,
    documentSlug: r.documentSlug,
    documentTitle: r.documentTitle,
    collectionId: r.collectionId,
    collectionSlug: r.collectionSlug,
    collectionName: r.collectionName,
    collectionKind: r.collectionKind as CollectionKind,
    chunkIndex: r.chunkIndex,
    body: r.body,
    similarity: 0,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    documentMetadata: (r.documentMetadata ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Group hits by (documentId, heading) and concat sibling chunks under the
 * same heading. The LLM gets the section as a unit instead of a 500-token
 * slice that may straddle a logical boundary.
 *
 * For chunks without a heading, the original chunk body is preserved.
 */
async function expandSections(hits: KbSearchHit[]): Promise<KbSearchHit[]> {
  const groups = new Map<string, KbSearchHit>();
  for (const hit of hits) {
    const heading = (hit.metadata as { heading?: string }).heading ?? null;
    const key = heading ? `${hit.documentId}::${heading}` : `chunk::${hit.chunkId}`;
    const existing = groups.get(key);
    if (!existing || hit.similarity > existing.similarity) {
      groups.set(key, hit);
    }
  }
  const winners = Array.from(groups.values());
  if (winners.length === 0) return hits;

  const db = getDb();
  const docIds = Array.from(new Set(winners.map((w) => w.documentId)));
  const allChunks = await db
    .select({
      documentId: kbChunks.documentId,
      chunkIndex: kbChunks.chunkIndex,
      body: kbChunks.bodyMd,
      metadata: kbChunks.metadata,
    })
    .from(kbChunks)
    .where(inArray(kbChunks.documentId, docIds))
    .orderBy(kbChunks.documentId, kbChunks.chunkIndex);

  const byDoc = new Map<string, typeof allChunks>();
  for (const c of allChunks) {
    const arr = byDoc.get(c.documentId) ?? [];
    arr.push(c);
    byDoc.set(c.documentId, arr);
  }

  return winners.map((w) => {
    const heading = (w.metadata as { heading?: string }).heading;
    if (!heading) return w;
    const doc = byDoc.get(w.documentId) ?? [];
    const section = doc
      .filter(
        (c) => ((c.metadata ?? {}) as { heading?: string }).heading === heading,
      )
      .map((c) => c.body)
      .join("\n\n");
    return { ...w, expandedSection: section };
  });
}
