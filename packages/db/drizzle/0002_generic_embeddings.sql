-- Migration 0002: Generic embeddings table
-- Replaces content_embeddings with a source-type-discriminated table that
-- supports content, brand_doc, and rejected_draft vectors.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0002_generic_embeddings.sql

--> statement-breakpoint

CREATE TYPE "embedding_source_type" AS ENUM ('content', 'brand_doc', 'rejected_draft');

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "embeddings" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_type" "embedding_source_type" NOT NULL,
  "source_id"   text        NOT NULL,
  "chunk_index" integer     NOT NULL DEFAULT 0,
  "text"        text        NOT NULL DEFAULT '',
  "embedding"   vector(1536) NOT NULL,
  "metadata"    jsonb       NOT NULL DEFAULT '{}',
  "model"       text        NOT NULL DEFAULT 'text-embedding-3-small',
  "embedded_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "embeddings_source_uq" UNIQUE ("source_type", "source_id", "chunk_index")
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "embeddings_source_type_idx"
  ON "embeddings" ("source_type");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "embeddings_source_id_idx"
  ON "embeddings" ("source_id");

--> statement-breakpoint

-- Partial ivfflat index for content vectors (large set).
-- ivfflat requires at least as many rows as `lists`; this creates gracefully.
CREATE INDEX IF NOT EXISTS "embeddings_content_ivfflat_idx"
  ON "embeddings" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100)
  WHERE (source_type = 'content');

--> statement-breakpoint

-- Partial ivfflat index for brand_doc vectors (small set, fewer lists).
CREATE INDEX IF NOT EXISTS "embeddings_brand_doc_ivfflat_idx"
  ON "embeddings" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 10)
  WHERE (source_type = 'brand_doc');

--> statement-breakpoint

-- Data migration: copy existing content_embeddings rows into the new table.
-- source_id is the content_items UUID serialized as text.
-- chunk_index = 0 because content_embeddings had one vector per content item.
INSERT INTO "embeddings"
  (source_type, source_id, chunk_index, text, embedding, metadata, model, embedded_at)
SELECT
  'content'::embedding_source_type,
  content_id::text,
  0,
  '',
  embedding,
  jsonb_build_object('content_id', content_id),
  model,
  embedded_at
FROM "content_embeddings"
ON CONFLICT ON CONSTRAINT "embeddings_source_uq" DO NOTHING;

-- NOTE: After verifying data parity in staging, run:
--   DROP TABLE "content_embeddings";
-- We keep it alive here to allow a safe rollback window.
