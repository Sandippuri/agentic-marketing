-- Migration 0015: Knowledge Base.
--
-- Three new tables (kb_collections, kb_documents, kb_chunks) form a unified,
-- queryable memory layer that replaces today's scattered surfaces:
--   - apps/manager/memory/{brand,channel-sops,product,playbooks}/*.md
--   - brand_memory rows (kept; will be archived after seed)
--   - brand_documents (kept; treated as raw input feeding kb)
-- Embeddings live in the existing `embeddings` table via a new
-- source_type='kb_chunk' so similarity search uses one index.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0015_knowledge_base.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kb_collection_kind') THEN
    CREATE TYPE "kb_collection_kind" AS ENUM (
      'brand', 'product', 'persona', 'competitor', 'sop', 'playbook',
      'past_content', 'asset_caption', 'visual_reference', 'external_doc'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kb_scope') THEN
    CREATE TYPE "kb_scope" AS ENUM ('global', 'campaign');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kb_doc_source') THEN
    CREATE TYPE "kb_doc_source" AS ENUM (
      'manual', 'extracted', 'agent', 'channel_sop', 'ga4', 'web', 'upload'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kb_doc_status') THEN
    CREATE TYPE "kb_doc_status" AS ENUM (
      'draft', 'active', 'archived', 'superseded'
    );
  END IF;
END$$;

--> statement-breakpoint

-- Add kb_chunk to the existing embedding_source_type enum.
-- Postgres requires ALTER TYPE ... ADD VALUE outside transaction blocks for
-- some versions; apply-sql.ts uses unsafe() so this runs fine.
ALTER TYPE "embedding_source_type" ADD VALUE IF NOT EXISTS 'kb_chunk';

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kb_collections" (
  "id"           uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"         text                     NOT NULL,
  "name"         text                     NOT NULL,
  "kind"         "kb_collection_kind"     NOT NULL,
  "scope"        "kb_scope"               NOT NULL DEFAULT 'global',
  "campaign_id"  uuid                     REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "description"  text,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "kb_collections_slug_uq" ON "kb_collections" ("slug");
CREATE INDEX IF NOT EXISTS "kb_collections_kind_idx"       ON "kb_collections" ("kind");
CREATE INDEX IF NOT EXISTS "kb_collections_campaign_idx"   ON "kb_collections" ("campaign_id");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kb_documents" (
  "id"             uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "collection_id"  uuid                     NOT NULL REFERENCES "kb_collections"("id") ON DELETE CASCADE,
  "slug"           text                     NOT NULL,
  "title"          text                     NOT NULL,
  "source"         "kb_doc_source"          NOT NULL DEFAULT 'manual',
  "source_ref"     text,
  "body_md"        text                     NOT NULL DEFAULT '',
  "metadata"       jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "version"        integer                  NOT NULL DEFAULT 1,
  "status"         "kb_doc_status"          NOT NULL DEFAULT 'active',
  "created_by"     uuid,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "kb_documents_collection_slug_uq"
  ON "kb_documents" ("collection_id", "slug");
CREATE INDEX IF NOT EXISTS "kb_documents_status_idx"     ON "kb_documents" ("status");
CREATE INDEX IF NOT EXISTS "kb_documents_collection_idx" ON "kb_documents" ("collection_id");
CREATE INDEX IF NOT EXISTS "kb_documents_updated_at_idx" ON "kb_documents" ("updated_at");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kb_chunks" (
  "id"           uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id"  uuid                     NOT NULL REFERENCES "kb_documents"("id") ON DELETE CASCADE,
  "chunk_index"  integer                  NOT NULL,
  "body_md"      text                     NOT NULL,
  "token_count"  integer                  NOT NULL DEFAULT 0,
  "metadata"     jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "kb_chunks_doc_idx_uq"
  ON "kb_chunks" ("document_id", "chunk_index");
CREATE INDEX IF NOT EXISTS "kb_chunks_document_idx" ON "kb_chunks" ("document_id");

--> statement-breakpoint

ALTER TABLE "kb_collections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_documents"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_chunks"      ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

DROP POLICY IF EXISTS "team_read_kb_collections" ON "kb_collections";
CREATE POLICY "team_read_kb_collections" ON "kb_collections"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_read_kb_documents" ON "kb_documents";
CREATE POLICY "team_read_kb_documents" ON "kb_documents"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_read_kb_chunks" ON "kb_chunks";
CREATE POLICY "team_read_kb_chunks" ON "kb_chunks"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_write_kb_documents" ON "kb_documents";
CREATE POLICY "team_write_kb_documents" ON "kb_documents"
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "team_write_kb_collections" ON "kb_collections";
CREATE POLICY "team_write_kb_collections" ON "kb_collections"
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
