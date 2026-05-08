-- Migration 0021: Hybrid retrieval support for the Knowledge Base.
--
-- Adds a STORED tsvector generated column on kb_chunks so we can run
-- BM25-style full-text search alongside the vector path, then fuse with
-- Reciprocal Rank Fusion (RRF) at retrieval time.
--
-- Generated columns are maintained by Postgres on every INSERT/UPDATE —
-- no application code change is required to populate the index.
--
-- Also adds a partial ivfflat index for the new kb_chunk source_type so
-- pgvector cosine search is fast at scale.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db apply-sql packages/db/drizzle/0021_kb_fulltext.sql

--> statement-breakpoint

-- 1. tsvector + GIN for BM25.
ALTER TABLE "kb_chunks"
  ADD COLUMN IF NOT EXISTS "tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(body_md, ''))) STORED;

CREATE INDEX IF NOT EXISTS "kb_chunks_tsv_idx"
  ON "kb_chunks" USING GIN ("tsv");

--> statement-breakpoint

-- 2. Partial ivfflat for kb_chunk vectors. ivfflat requires the row count
-- to exceed `lists`; the index is created lazily and the planner falls
-- back to a sequential scan on small tables.
CREATE INDEX IF NOT EXISTS "embeddings_kb_chunk_ivfflat_idx"
  ON "embeddings" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100)
  WHERE (source_type = 'kb_chunk');
