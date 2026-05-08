-- Migration 0013: brand_documents + extraction_runs + brand_memory_drafts.
-- Lets admins upload PDFs / DOCX / MD / TXT, run a multi-doc extraction
-- pipeline, and review per-slug drafts before they replace brand_memory.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0013_brand_documents.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brand_doc_status') THEN
    CREATE TYPE "brand_doc_status" AS ENUM (
      'uploaded', 'parsing', 'parsed', 'embedding', 'embedded', 'failed', 'removed'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brand_draft_status') THEN
    CREATE TYPE "brand_draft_status" AS ENUM (
      'pending', 'approved', 'rejected', 'superseded'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'extraction_run_status') THEN
    CREATE TYPE "extraction_run_status" AS ENUM (
      'running', 'completed', 'failed'
    );
  END IF;
END$$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brand_documents" (
  "id"               uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "filename"         text                     NOT NULL,
  "mime_type"        text                     NOT NULL,
  "size_bytes"       bigint                   NOT NULL,
  "storage_path"     text                     NOT NULL,
  "parsed_text_path" text,
  "page_count"       integer,
  "status"           "brand_doc_status"       NOT NULL DEFAULT 'uploaded',
  "error"            text,
  "uploaded_by"      uuid,
  "uploaded_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "removed_at"       timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brand_documents_status_idx"      ON "brand_documents" ("status");
CREATE INDEX IF NOT EXISTS "brand_documents_uploaded_at_idx" ON "brand_documents" ("uploaded_at");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "extraction_runs" (
  "id"              uuid                       PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "triggered_by"    uuid,
  "status"          "extraction_run_status"    NOT NULL DEFAULT 'running',
  "source_doc_ids"  jsonb                      NOT NULL DEFAULT '[]'::jsonb,
  "model"           text,
  "error"           text,
  "started_at"      timestamp with time zone   NOT NULL DEFAULT now(),
  "completed_at"    timestamp with time zone
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "extraction_runs_status_idx"  ON "extraction_runs" ("status");
CREATE INDEX IF NOT EXISTS "extraction_runs_started_idx" ON "extraction_runs" ("started_at");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brand_memory_drafts" (
  "id"          uuid                       PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id"      uuid                       NOT NULL REFERENCES "extraction_runs"("id") ON DELETE CASCADE,
  "slug"        text                       NOT NULL,
  "ai_body"     text                       NOT NULL DEFAULT '',
  "human_body"  text,
  "status"      "brand_draft_status"       NOT NULL DEFAULT 'pending',
  "confidence"  numeric,
  "citations"   jsonb                      NOT NULL DEFAULT '[]'::jsonb,
  "decided_by"  uuid,
  "decided_at"  timestamp with time zone,
  "reason"      text,
  "created_at"  timestamp with time zone   NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone   NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brand_memory_drafts_slug_idx"   ON "brand_memory_drafts" ("slug");
CREATE INDEX IF NOT EXISTS "brand_memory_drafts_status_idx" ON "brand_memory_drafts" ("status");
CREATE INDEX IF NOT EXISTS "brand_memory_drafts_run_idx"    ON "brand_memory_drafts" ("run_id");

--> statement-breakpoint

ALTER TABLE "brand_documents"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "extraction_runs"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_memory_drafts"  ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

-- Authenticated team members can read; writes only via service role.
DROP POLICY IF EXISTS "team_read_brand_documents" ON "brand_documents";
CREATE POLICY "team_read_brand_documents" ON "brand_documents"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_read_extraction_runs" ON "extraction_runs";
CREATE POLICY "team_read_extraction_runs" ON "extraction_runs"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_read_brand_memory_drafts" ON "brand_memory_drafts";
CREATE POLICY "team_read_brand_memory_drafts" ON "brand_memory_drafts"
  FOR SELECT TO authenticated USING (true);
