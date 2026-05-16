-- ============================================================
-- BOOTSTRAP: marketing-agent schema for a fresh Supabase project
-- Generated 2026-05-16T06:14:54Z from migrations 0000–0033
--
-- Run order:
--   1. (this file)         migrations 0000–0033 in numeric order
--   2. infra/supabase/policies.sql   RLS policies
--   3. infra/supabase/views.sql      named views
--   4. infra/supabase/seed.sql       default settings rows
--   5. tsx scripts/bootstrap-saas.ts  legacy workspace + first owner
--
-- Apply via Supabase dashboard → SQL Editor → New query, or:
--   DATABASE_URL=<direct-url-5432> \
--     pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts \
--     drizzle/bootstrap.sql
-- ============================================================


-- ============================================================
-- 0000_lowly_gideon
-- ============================================================
CREATE TYPE "public"."actor_kind" AS ENUM('human', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'changes_requested', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('poster', 'hero', 'og', 'email_header');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('draft', 'in_review', 'approved', 'published');--> statement-breakpoint
CREATE TYPE "public"."campaign_phase" AS ENUM('buildup', 'launch', 'post_launch');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('internal_blog', 'linkedin', 'x', 'email_hubspot', 'email_mailchimp');--> statement-breakpoint
CREATE TYPE "public"."content_stage" AS ENUM('pull', 'explain', 'reinforce', 'push');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'in_review', 'approved', 'scheduled', 'published', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('blog', 'linkedin', 'x_thread', 'x_post', 'email');--> statement-breakpoint
CREATE TYPE "public"."publish_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('content', 'campaign');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decision" "approval_decision",
	"decided_by" uuid,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"status" "asset_status" DEFAULT 'draft' NOT NULL,
	"storage_path" text NOT NULL,
	"template_id" text,
	"prompt_used" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_kind" "actor_kind" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"phase" "campaign_phase" DEFAULT 'buildup' NOT NULL,
	"owner_id" uuid,
	"start_date" date,
	"end_date" date,
	"brief_md" text,
	"calendar_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"type" "content_type" NOT NULL,
	"stage" "content_stage" DEFAULT 'explain' NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"channel_hints" jsonb,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_url" text,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"body_md" text NOT NULL,
	"change_note" text,
	"author_id" uuid,
	"author_kind" "actor_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" "scope_type" NOT NULL,
	"scope_id" uuid NOT NULL,
	"channel" "channel",
	"metric" text NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" "publish_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"external_url" text,
	"error" text,
	"thread_ref" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_content_idx" ON "approvals" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_content_idx" ON "assets" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_slug_uq" ON "campaigns" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_items_campaign_idx" ON "content_items" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_items_status_idx" ON "content_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_items_stage_idx" ON "content_items" USING btree ("stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_revisions_content_idx" ON "content_revisions" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metrics_scope_idx" ON "metrics" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metrics_metric_idx" ON "metrics" USING btree ("metric");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_content_idx" ON "publish_jobs" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_status_idx" ON "publish_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_channel_idx" ON "publish_jobs" USING btree ("channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_channel_created_idx" ON "publish_jobs" USING btree ("channel","created_at");

-- ============================================================
-- 0001_learning_loop
-- ============================================================
-- Phase 11: Learning Loop
-- Requires pgvector extension (enable once per Supabase project).
CREATE EXTENSION IF NOT EXISTS vector;

--> statement-breakpoint

-- agent_feedback: captures every approval decision for future fine-tuning
CREATE TABLE IF NOT EXISTS "agent_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_id" uuid NOT NULL REFERENCES "content_items"("id") ON DELETE CASCADE,
  "revision_id" uuid,
  "ai_draft_md" text NOT NULL,
  "human_final_md" text,
  "decision" "approval_decision" NOT NULL,
  "edit_distance" integer,
  "decided_by" uuid,
  "decided_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reason" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_feedback_content_idx" ON "agent_feedback" ("content_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_feedback_decision_idx" ON "agent_feedback" ("decision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_feedback_decided_at_idx" ON "agent_feedback" ("decided_at");

--> statement-breakpoint

-- outcomes: rolled-up performance metrics per content × channel × window
CREATE TABLE IF NOT EXISTS "outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_id" uuid NOT NULL REFERENCES "content_items"("id") ON DELETE CASCADE,
  "channel" "channel" NOT NULL,
  "window" text NOT NULL,
  "impressions" integer NOT NULL DEFAULT 0,
  "clicks" integer NOT NULL DEFAULT 0,
  "ctr" numeric(10, 6) NOT NULL DEFAULT 0,
  "conversions" integer NOT NULL DEFAULT 0,
  "engagement_rate" numeric(10, 6) NOT NULL DEFAULT 0,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outcomes_content_channel_window_uq"
  ON "outcomes" ("content_id", "channel", "window");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcomes_ctr_idx" ON "outcomes" ("ctr");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcomes_channel_idx" ON "outcomes" ("channel");

--> statement-breakpoint

-- content_embeddings: text-embedding-3-small vectors for semantic retrieval
CREATE TABLE IF NOT EXISTS "content_embeddings" (
  "content_id" uuid PRIMARY KEY REFERENCES "content_items"("id") ON DELETE CASCADE,
  "embedding" vector(1536) NOT NULL,
  "embedded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "model" text NOT NULL DEFAULT 'text-embedding-3-small'
);
--> statement-breakpoint
-- ivfflat index for cosine similarity search (tune lists= for your dataset size)
CREATE INDEX IF NOT EXISTS "content_embeddings_ivfflat_idx"
  ON "content_embeddings" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);


-- ============================================================
-- 0002_generic_embeddings
-- ============================================================
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


-- ============================================================
-- 0003_drop_content_embeddings
-- ============================================================
-- Migration 0003: Remove legacy content_embeddings (superseded by `embeddings`, source_type='content').
-- Apply after `0002_generic_embeddings` migration (data copied in 0002).
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0003_drop_content_embeddings.sql

--> statement-breakpoint

DROP TABLE IF EXISTS "content_embeddings";


-- ============================================================
-- 0004_brand_memory
-- ============================================================
-- Migration 0004: brand_memory table + its RLS.
-- Stores the five brand/product documents that used to live as Markdown files
-- in apps/manager/memory/{brand,product}/*.md so non-engineers can edit voice
-- / ICP / positioning / visual / product state from the admin UI.
--
-- Going forward, RLS for new tables ships INSIDE the migration (idempotent
-- via DROP POLICY IF EXISTS) instead of being added to infra/supabase/policies.sql.
-- That way an upgrade only ever needs to apply migrations.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0004_brand_memory.sql

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brand_memory" (
  "id"         uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"       text                     NOT NULL,
  "title"      text                     NOT NULL,
  "body"       text                     NOT NULL DEFAULT '',
  "updated_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "brand_memory_slug_uq" UNIQUE ("slug")
);

--> statement-breakpoint

ALTER TABLE "brand_memory" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

-- Authenticated team members can read. Writes happen via the service role
-- (the admin UI's PUT route) — no team_write policy on purpose.
DROP POLICY IF EXISTS "team_read_brand_memory" ON "brand_memory";
CREATE POLICY "team_read_brand_memory" ON "brand_memory"
  FOR SELECT TO authenticated USING (true);


-- ============================================================
-- 0005_publish_job_mode
-- ============================================================
-- Migration 0005: publish_jobs.mode.
-- Distinguishes test publishes (driven from the admin test-chat) from real
-- live publishes. Test-mode jobs are short-circuited by the distributor —
-- no real social/email API calls — but flow through the rest of the pipeline
-- so the operator can validate the full loop without connecting accounts.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0005_publish_job_mode.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'publish_job_mode'
  ) THEN
    CREATE TYPE "publish_job_mode" AS ENUM ('live', 'test');
  END IF;
END$$;

ALTER TABLE "publish_jobs"
  ADD COLUMN IF NOT EXISTS "mode" "publish_job_mode" NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS "publish_jobs_mode_idx" ON "publish_jobs" ("mode");


-- ============================================================
-- 0006_brand_design_system
-- ============================================================
-- Migration 0006: brand_design_system table + RLS.
-- Stores the structured design tokens (color palette, typography, logo
-- references, spacing/radii notes) that the asset sub-agent and human
-- operators consult when producing branded creative. Logos are stored as
-- file paths in the existing `assets` Supabase Storage bucket; everything
-- else is JSONB.
--
-- One row per slug. Today only 'default' is used; the slug column is
-- there so we can host multiple brands in the same install later without
-- another migration.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0006_brand_design_system.sql

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brand_design_system" (
  "id"         uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"       text                     NOT NULL DEFAULT 'default',
  "colors"     jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "typography" jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "logos"      jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "tokens"     jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "updated_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "brand_design_system_slug_uq" UNIQUE ("slug")
);

--> statement-breakpoint

ALTER TABLE "brand_design_system" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

-- Same pattern as brand_memory: authenticated team members read; writes go
-- through the service role on the admin PUT route.
DROP POLICY IF EXISTS "team_read_brand_design_system" ON "brand_design_system";
CREATE POLICY "team_read_brand_design_system" ON "brand_design_system"
  FOR SELECT TO authenticated USING (true);


-- ============================================================
-- 0007_generation_jobs
-- ============================================================
-- Migration 0007: generation_jobs + generation_job_steps.
-- Tracks one end-user request through the orchestrator as a unit so the
-- /creation-workflow admin page can show step-by-step progress
-- (strategist → content → asset → ...). Pure instrumentation: writes
-- happen alongside the existing flow, no behaviour change.
--
-- A row is only inserted when at least one sub-agent actually runs;
-- pure-conversation chat turns don't create a job.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0007_generation_jobs.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'generation_job_status') THEN
    CREATE TYPE "generation_job_status" AS ENUM ('running', 'completed', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'generation_job_kind') THEN
    CREATE TYPE "generation_job_kind" AS ENUM ('campaign', 'single_post', 'asset', 'analysis', 'publish', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'generation_step_name') THEN
    CREATE TYPE "generation_step_name" AS ENUM ('strategist', 'content', 'asset', 'analyst', 'distributor');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'generation_step_status') THEN
    CREATE TYPE "generation_step_status" AS ENUM ('running', 'succeeded', 'failed');
  END IF;
END$$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "generation_jobs" (
  "id"            uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_ref"    text,
  "user_id"       text,
  "user_message"  text                     NOT NULL,
  "kind"          "generation_job_kind"    NOT NULL DEFAULT 'other',
  "status"        "generation_job_status"  NOT NULL DEFAULT 'running',
  "current_step"  "generation_step_name",
  "campaign_id"   uuid                     REFERENCES "campaigns"("id") ON DELETE SET NULL,
  "content_id"    uuid                     REFERENCES "content_items"("id") ON DELETE SET NULL,
  "error"         text,
  "started_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at"  timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "generation_jobs_status_idx"  ON "generation_jobs" ("status");
CREATE INDEX IF NOT EXISTS "generation_jobs_thread_idx"  ON "generation_jobs" ("thread_ref");
CREATE INDEX IF NOT EXISTS "generation_jobs_created_idx" ON "generation_jobs" ("created_at" DESC);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "generation_job_steps" (
  "id"           uuid                       PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id"       uuid                       NOT NULL REFERENCES "generation_jobs"("id") ON DELETE CASCADE,
  "name"         "generation_step_name"     NOT NULL,
  "status"       "generation_step_status"   NOT NULL DEFAULT 'running',
  "input"        jsonb,
  "output"       jsonb,
  "error"        text,
  "started_at"   timestamp with time zone   NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "generation_job_steps_job_idx"     ON "generation_job_steps" ("job_id");
CREATE INDEX IF NOT EXISTS "generation_job_steps_started_idx" ON "generation_job_steps" ("started_at");

--> statement-breakpoint

ALTER TABLE "generation_jobs"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generation_job_steps" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

-- Authenticated team members can read; writes only via service role
-- (the manager / web internal routes). Same pattern as publish_jobs.
DROP POLICY IF EXISTS "team_read_generation_jobs" ON "generation_jobs";
CREATE POLICY "team_read_generation_jobs" ON "generation_jobs"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_read_generation_job_steps" ON "generation_job_steps";
CREATE POLICY "team_read_generation_job_steps" ON "generation_job_steps"
  FOR SELECT TO authenticated USING (true);

--> statement-breakpoint

-- Expose to Supabase Realtime so the admin UI can subscribe to changes.
-- Idempotent and tolerant of installs without the supabase_realtime publication
-- (e.g. local Postgres without the Supabase realtime extension).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'generation_jobs'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE generation_jobs';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'generation_job_steps'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE generation_job_steps';
    END IF;
  END IF;
END$$;


-- ============================================================
-- 0008_campaign_scoped_brand
-- ============================================================
-- Migration 0008: campaign-scoped brand memory and design system.
--
-- Until now `brand_memory` and `brand_design_system` were global singletons
-- (one row per slug). Campaigns may now carry their own brand voice and
-- design overrides. The global rows (campaign_id IS NULL) remain the
-- default; a row with the same slug AND a non-null campaign_id wins for
-- that campaign.
--
-- Resolution at read time:
--   SELECT ... WHERE slug = :slug AND (campaign_id = :id OR campaign_id IS NULL)
--   ORDER BY campaign_id NULLS LAST LIMIT 1
--
-- Unique constraints:
--   - At most one global row per slug    (campaign_id IS NULL)
--   - At most one row per (slug, campaign) (campaign_id IS NOT NULL)
-- Postgres treats NULL as distinct in regular UNIQUE constraints, so we
-- enforce both with two partial unique indexes.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0008_campaign_scoped_brand.sql

--> statement-breakpoint

ALTER TABLE "brand_memory"
  ADD COLUMN IF NOT EXISTS "campaign_id" uuid
  REFERENCES "campaigns"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "brand_memory"
  DROP CONSTRAINT IF EXISTS "brand_memory_slug_uq";

--> statement-breakpoint

DROP INDEX IF EXISTS "brand_memory_slug_uq";

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brand_memory_slug_global_uq"
  ON "brand_memory" ("slug")
  WHERE "campaign_id" IS NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brand_memory_slug_campaign_uq"
  ON "brand_memory" ("slug", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brand_memory_campaign_idx"
  ON "brand_memory" ("campaign_id");

--> statement-breakpoint

ALTER TABLE "brand_design_system"
  ADD COLUMN IF NOT EXISTS "campaign_id" uuid
  REFERENCES "campaigns"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "brand_design_system"
  DROP CONSTRAINT IF EXISTS "brand_design_system_slug_uq";

--> statement-breakpoint

DROP INDEX IF EXISTS "brand_design_system_slug_uq";

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_system_slug_global_uq"
  ON "brand_design_system" ("slug")
  WHERE "campaign_id" IS NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_system_slug_campaign_uq"
  ON "brand_design_system" ("slug", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brand_design_system_campaign_idx"
  ON "brand_design_system" ("campaign_id");


-- ============================================================
-- 0009_workflow_runs
-- ============================================================
-- Migration 0009: workflow_runs.
-- Engine-agnostic dashboard layer. Every workflow run, regardless of which
-- backend executes it (custom orchestrator, Vercel Workflows, future
-- Cloudflare Workflows), writes one row here at start and updates status
-- on completion. The Creation workflow page reads this table so all engines
-- show up in one list.
--
-- engine_run_ref points back to the engine-native id:
--   - custom    → generation_jobs.id   (uuid as text)
--   - vercel    → vercel run id        (text)
--   - cloudflare → future workflow id  (text)
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0009_workflow_runs.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_engine') THEN
    CREATE TYPE "workflow_engine" AS ENUM ('custom', 'vercel', 'cloudflare');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_status') THEN
    CREATE TYPE "workflow_run_status" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');
  END IF;
END$$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id"              uuid                       PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engine"          "workflow_engine"          NOT NULL,
  "kind"            "generation_job_kind"      NOT NULL,
  "status"          "workflow_run_status"      NOT NULL DEFAULT 'queued',
  "request"         text                       NOT NULL,
  "thread_ref"      text,
  "user_id"         text,
  "engine_run_ref"  text,
  "campaign_id"     uuid                       REFERENCES "campaigns"("id") ON DELETE SET NULL,
  "content_id"      uuid                       REFERENCES "content_items"("id") ON DELETE SET NULL,
  "input"           jsonb,
  "error"           text,
  "started_at"      timestamp with time zone   NOT NULL DEFAULT now(),
  "completed_at"    timestamp with time zone,
  "created_at"      timestamp with time zone   NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone   NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "workflow_runs_engine_idx"  ON "workflow_runs" ("engine");
CREATE INDEX IF NOT EXISTS "workflow_runs_status_idx"  ON "workflow_runs" ("status");
CREATE INDEX IF NOT EXISTS "workflow_runs_thread_idx"  ON "workflow_runs" ("thread_ref");
CREATE INDEX IF NOT EXISTS "workflow_runs_created_idx" ON "workflow_runs" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "workflow_runs_engine_ref_idx" ON "workflow_runs" ("engine_run_ref");

--> statement-breakpoint

ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_read_workflow_runs" ON "workflow_runs";
CREATE POLICY "team_read_workflow_runs" ON "workflow_runs"
  FOR SELECT TO authenticated USING (true);

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'workflow_runs'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE workflow_runs';
    END IF;
  END IF;
END$$;


-- ============================================================
-- 0010_content_needs_images
-- ============================================================
-- Migration 0010: per-post image-generation toggle.
--
-- Adds `needs_images` to content_items so the human reviewer (or sub-agent)
-- can decide on a per-post basis whether the submit-for-review hook should
-- generate Replicate variants. Defaults to true to preserve existing
-- behaviour; the submit endpoint reads the flag and skips image generation
-- when false. Toggling the flag from false to true via PATCH /api/content/:id
-- re-triggers generation if no assets exist yet.

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "needs_images" boolean NOT NULL DEFAULT true;


-- ============================================================
-- 0011_video_assets
-- ============================================================
-- Migration 0011: promotional video assets.
--
-- Adds the `video_post` value to the asset_kind enum and two new columns on
-- `assets` to record the file's MIME type (so cards know whether to render
-- <img> vs <video>) and clip duration in seconds (Veo 3.1 returns 4–8s).
-- Both new columns are nullable so existing image rows are unaffected.

ALTER TYPE "asset_kind" ADD VALUE IF NOT EXISTS 'video_post';

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "mime_type" text;

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "duration_sec" integer;


-- ============================================================
-- 0012_llm_usage
-- ============================================================
-- Migration 0012: per-call LLM usage + cost tracking.
--
-- One row per generateText / generateObject call across the orchestrator,
-- sub-agents, and workflows. Written by recordLlmUsage in @marketing/agents
-- and surfaced on the settings page (and any future cost dashboards).
--
-- cost_usd is computed at write time from the static price map in
-- @marketing/shared-types (LLM_PRICING) so historical rows remain correct
-- even if list prices change later. Null when the model id is not in the
-- price map.

CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "agent" text NOT NULL,
  "thread_ref" text,
  "job_id" uuid,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cached_input_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric(12, 6),
  "error" text
);

CREATE INDEX IF NOT EXISTS "llm_usage_occurred_at_idx"
  ON "llm_usage" ("occurred_at");
CREATE INDEX IF NOT EXISTS "llm_usage_model_idx"
  ON "llm_usage" ("model");
CREATE INDEX IF NOT EXISTS "llm_usage_agent_idx"
  ON "llm_usage" ("agent");


-- ============================================================
-- 0013_brand_documents
-- ============================================================
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


-- ============================================================
-- 0014_llm_usage_workflow_run
-- ============================================================
-- Migration 0014: link llm_usage rows to their workflow_runs.
--
-- Adds a nullable foreign key so the /api/usage/by-workflow/[id] endpoint
-- (and any future per-run cost dashboard) can sum tokens for a single run
-- regardless of which engine executed it. Stays nullable so calls outside
-- a workflow (e.g. chat orchestrator turns) can still record usage.

ALTER TABLE "llm_usage"
  ADD COLUMN IF NOT EXISTS "workflow_run_id" uuid
  REFERENCES "workflow_runs"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "llm_usage_workflow_run_idx"
  ON "llm_usage" ("workflow_run_id");


-- ============================================================
-- 0015_knowledge_base
-- ============================================================
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


-- ============================================================
-- 0016_goal_loop
-- ============================================================
-- Migration 0016: Goal-driven autonomous campaigns.
--
-- Extends `campaigns` with the fields a long-running goal loop needs to
-- plan → fan out → wait on approvals → publish → measure → re-evaluate
-- with budget/deadline guard rails and resume-on-crash semantics.
--
-- New `goal_events` table is the durable trail the goal-loop workflow
-- reads on resume. Combined with Vercel Workflows' native durable
-- execution, the loop can be killed and restarted safely.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0016_goal_loop.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loop_status') THEN
    CREATE TYPE "loop_status" AS ENUM (
      'idle', 'planning', 'executing', 'awaiting_approval',
      'measuring', 'converged', 'failed', 'halted'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'goal_event_kind') THEN
    CREATE TYPE "goal_event_kind" AS ENUM (
      'plan_drafted', 'fanout_started', 'approval_requested',
      'approval_resolved', 'published', 'outcome_observed',
      'reevaluated', 'converged', 'halted', 'error'
    );
  END IF;
END$$;

--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "goal_definition"   jsonb,
  ADD COLUMN IF NOT EXISTS "target_metrics"    jsonb,
  ADD COLUMN IF NOT EXISTS "loop_status"       "loop_status" NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS "loop_iteration"    integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "budget_cents"      integer,
  ADD COLUMN IF NOT EXISTS "cost_cents_spent"  integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deadline"          timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_iteration_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "parent_goal_id"    uuid;

CREATE INDEX IF NOT EXISTS "campaigns_loop_status_idx" ON "campaigns" ("loop_status");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "goal_events" (
  "id"           uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id"  uuid                     NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "iteration"    integer                  NOT NULL DEFAULT 0,
  "kind"         "goal_event_kind"        NOT NULL,
  "step_key"     text,
  "payload"      jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "ts"           timestamp with time zone NOT NULL DEFAULT now()
);

-- Idempotency key: (campaign_id, iteration, step_key) when step_key set.
-- Used by the loop's step.do() wrappers to skip work that already happened.
CREATE UNIQUE INDEX IF NOT EXISTS "goal_events_idempotency_uq"
  ON "goal_events" ("campaign_id", "iteration", "step_key")
  WHERE "step_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "goal_events_campaign_idx"  ON "goal_events" ("campaign_id");
CREATE INDEX IF NOT EXISTS "goal_events_kind_idx"      ON "goal_events" ("kind");
CREATE INDEX IF NOT EXISTS "goal_events_ts_idx"        ON "goal_events" ("ts");

--> statement-breakpoint

ALTER TABLE "goal_events" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_read_goal_events" ON "goal_events";
CREATE POLICY "team_read_goal_events" ON "goal_events"
  FOR SELECT TO authenticated USING (true);


-- ============================================================
-- 0017_variants
-- ============================================================
-- Migration 0017: A/B variants + SEO metadata on content_items.
--
-- variant_group: shared uuid for items belonging to the same A/B test
-- variant_index: 0-based ordinal within the group (variant A=0, B=1, …)
-- experiment_id: FK populated when an experiments row is created in 0018
-- seo_meta:      structured title/description/keywords/h-tags written by
--                the SEO sub-agent (Phase 3); free-form jsonb to allow
--                schema evolution without migrations.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0017_variants.sql

--> statement-breakpoint

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "variant_group"  uuid,
  ADD COLUMN IF NOT EXISTS "variant_index"  integer,
  ADD COLUMN IF NOT EXISTS "experiment_id"  uuid,
  ADD COLUMN IF NOT EXISTS "seo_meta"       jsonb;

CREATE INDEX IF NOT EXISTS "content_items_variant_group_idx"
  ON "content_items" ("variant_group");
CREATE INDEX IF NOT EXISTS "content_items_experiment_idx"
  ON "content_items" ("experiment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "content_items_experiment_variant_uq"
  ON "content_items" ("experiment_id", "variant_index")
  WHERE "experiment_id" IS NOT NULL AND "variant_index" IS NOT NULL;


-- ============================================================
-- 0018_experiments
-- ============================================================
-- Migration 0018: Experiments registry for A/B variant tracking.
--
-- One row per experiment. The Growth/Experiment sub-agent (Phase 3)
-- creates the row, then propose_winner reads outcomes and sets
-- winner_content_id when the configured threshold is hit.
--
-- threshold_json shape: { kind: "ctr_lift" | "cpm" | "engagement",
--                         min_sample_size: int, confidence: 0.0..1.0 }
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0018_experiments.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'experiment_status') THEN
    CREATE TYPE "experiment_status" AS ENUM ('running', 'stopped', 'won', 'inconclusive');
  END IF;
END$$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "experiments" (
  "id"                 uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id"        uuid                     NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "variant_group"      uuid                     NOT NULL,
  "hypothesis"         text                     NOT NULL DEFAULT '',
  "metric"             text                     NOT NULL DEFAULT 'ctr',
  "threshold_json"     jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "status"             "experiment_status"      NOT NULL DEFAULT 'running',
  "winner_content_id"  uuid                     REFERENCES "content_items"("id") ON DELETE SET NULL,
  "sample_size"        integer                  NOT NULL DEFAULT 0,
  "started_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at"           timestamp with time zone,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "experiments_variant_group_uq"
  ON "experiments" ("variant_group");
CREATE INDEX IF NOT EXISTS "experiments_campaign_idx" ON "experiments" ("campaign_id");
CREATE INDEX IF NOT EXISTS "experiments_status_idx"   ON "experiments" ("status");

--> statement-breakpoint

-- Now that the experiments table exists, wire the FK from content_items.
-- (Column was added in 0017; we deferred the FK until the target existed.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'content_items' AND constraint_name = 'content_items_experiment_id_fk'
  ) THEN
    ALTER TABLE "content_items"
      ADD CONSTRAINT "content_items_experiment_id_fk"
      FOREIGN KEY ("experiment_id") REFERENCES "experiments"("id") ON DELETE SET NULL;
  END IF;
END$$;

--> statement-breakpoint

ALTER TABLE "experiments" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_read_experiments" ON "experiments";
CREATE POLICY "team_read_experiments" ON "experiments"
  FOR SELECT TO authenticated USING (true);


-- ============================================================
-- 0019_lifecycle
-- ============================================================
-- Migration 0019: Lifecycle / CRM email sequences.
--
-- A sequence is an ordered list of content_items each backed by a
-- delay (delay_hours) from the previous step's publish-success event.
-- Goal-loop schedules step k+1 by inserting a publish_jobs row with
-- sequence_id + sequence_step_index when step k completes.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0019_lifecycle.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lifecycle_status') THEN
    CREATE TYPE "lifecycle_status" AS ENUM (
      'draft', 'active', 'paused', 'completed', 'archived'
    );
  END IF;
END$$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lifecycle_sequences" (
  "id"                uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id"       uuid                     NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "name"              text                     NOT NULL,
  "channel"           "channel"                NOT NULL,
  "audience_segment"  text,
  "status"            "lifecycle_status"       NOT NULL DEFAULT 'draft',
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "lifecycle_sequences_campaign_idx" ON "lifecycle_sequences" ("campaign_id");
CREATE INDEX IF NOT EXISTS "lifecycle_sequences_status_idx"   ON "lifecycle_sequences" ("status");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lifecycle_steps" (
  "id"             uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence_id"    uuid                     NOT NULL REFERENCES "lifecycle_sequences"("id") ON DELETE CASCADE,
  "step_index"     integer                  NOT NULL,
  "content_id"     uuid                     REFERENCES "content_items"("id") ON DELETE SET NULL,
  "delay_hours"    integer                  NOT NULL DEFAULT 0,
  "trigger_event"  text                     NOT NULL DEFAULT 'previous_published',
  "created_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "lifecycle_steps_sequence_index_uq"
  ON "lifecycle_steps" ("sequence_id", "step_index");
CREATE INDEX IF NOT EXISTS "lifecycle_steps_content_idx" ON "lifecycle_steps" ("content_id");

--> statement-breakpoint

ALTER TABLE "publish_jobs"
  ADD COLUMN IF NOT EXISTS "sequence_id"          uuid REFERENCES "lifecycle_sequences"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "sequence_step_index"  integer;

CREATE INDEX IF NOT EXISTS "publish_jobs_sequence_idx" ON "publish_jobs" ("sequence_id");

--> statement-breakpoint

ALTER TABLE "lifecycle_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lifecycle_steps"     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_read_lifecycle_sequences" ON "lifecycle_sequences";
CREATE POLICY "team_read_lifecycle_sequences" ON "lifecycle_sequences"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_read_lifecycle_steps" ON "lifecycle_steps";
CREATE POLICY "team_read_lifecycle_steps" ON "lifecycle_steps"
  FOR SELECT TO authenticated USING (true);


-- ============================================================
-- 0020_brand_visual_language
-- ============================================================
-- Migration 0020: Extend brand_design_system with visual_language.
--
-- Today brand_design_system stores colors / typography / logos / tokens
-- (the "what to use"). The asset agent picks up the right palette but
-- still produces generic stock-AI imagery because there's no field for
-- the "how to compose, what NOT to look like".
--
-- visual_language jsonb shape (free-form, evolves with brand):
--   {
--     signature_compositions: string[]
--     banned_aesthetics: string[]            // negative-prompt seeds
--     motion_language: string                // for video assets
--     typography_in_image: { rules: string[] }
--     mood_keywords: string[]
--     lighting: string
--     subjects_to_prefer: string[]
--     subjects_to_avoid: string[]
--   }
--
-- Read by the new Art Director sub-agent (Phase 2.5) before any image
-- generation step.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0020_brand_visual_language.sql

--> statement-breakpoint

ALTER TABLE "brand_design_system"
  ADD COLUMN IF NOT EXISTS "visual_language" jsonb NOT NULL DEFAULT '{}'::jsonb;


-- ============================================================
-- 0021_kb_fulltext
-- ============================================================
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


-- ============================================================
-- 0022_visual_brief
-- ============================================================
-- Migration 0022: persist the Art Director's visual concept brief on the
-- content_items row so multiple modalities (image, video, future carousels)
-- consume one source of truth instead of re-deriving creative direction.
--
-- visual_brief is free-form jsonb (the brief shape evolves) but at least
-- always contains: concept_summary, composition, focal_point, real_subjects,
-- reference_image_urls, style_notes, banned_elements, and optional motion.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0022_visual_brief.sql

--> statement-breakpoint

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "visual_brief" jsonb;


-- ============================================================
-- 0023_asset_judge_scores
-- ============================================================
-- Migration 0023: persist the Asset Judge's per-candidate score on the asset
-- row itself, so the learning loop (Phase D) can query "high-scoring assets
-- that also performed well" without re-scoring.
--
-- judge_score holds the full structured payload (axes + verdict + reason) as
-- JSONB so the schema can evolve without further migrations.
-- judge_total is denormalized as a scalar for fast filtering / sorting /
-- composite indexes against outcomes data.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0023_asset_judge_scores.sql

--> statement-breakpoint

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "judge_score"     jsonb,
  ADD COLUMN IF NOT EXISTS "judge_total"     numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "judge_verdict"   text;

-- Sort/filter index — high-scoring assets are what get promoted into the KB
-- in the nightly job, so the most common query is "ORDER BY judge_total DESC
-- WHERE judge_verdict='accept'".
CREATE INDEX IF NOT EXISTS "assets_judge_total_idx"
  ON "assets" ("judge_total" DESC NULLS LAST);


-- ============================================================
-- 0024_saas_foundation
-- ============================================================
-- Migration 0024: SaaS foundation.
-- Adds the workspace / billing / metering tables. Does NOT touch existing
-- tenant tables (those get their nullable `workspace_id` column in 0025) and
-- does NOT enforce anything in the running app — PR 1's goal is "schema
-- exists, app behaves identically."
--
-- Idempotency: every CREATE uses IF NOT EXISTS and every plan seed uses
-- INSERT … ON CONFLICT DO UPDATE so this file can be applied multiple times
-- against the same database.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0024_saas_foundation.sql

--> statement-breakpoint

-- --- enums --------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "plan_code" AS ENUM ('free','starter','growth','business','enterprise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "subscription_status" AS ENUM ('trialing','active','past_due','grace','canceled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "billing_provider" AS ENUM ('khalti','stripe','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "billing_period" AS ENUM ('monthly','yearly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "workspace_role" AS ENUM ('owner','admin','editor','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "admin_role" AS ENUM ('superadmin','support');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --- workspaces ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"                    text NOT NULL,
  "name"                    text NOT NULL,
  "owner_user_id"           uuid NOT NULL,
  "plan_id"                 uuid NOT NULL,
  "plan_overridden_until"   timestamptz,
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  "updated_at"              timestamptz NOT NULL DEFAULT now(),
  "deleted_at"              timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_slug_uq"  ON "workspaces" ("slug");
CREATE INDEX        IF NOT EXISTS "workspaces_owner_idx" ON "workspaces" ("owner_user_id");
CREATE INDEX        IF NOT EXISTS "workspaces_plan_idx"  ON "workspaces" ("plan_id");

-- --- plans --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "plans" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"                     plan_code NOT NULL,
  "name"                     text NOT NULL,
  "description"              text NOT NULL DEFAULT '',
  "price_monthly_npr"        integer NOT NULL DEFAULT 0,
  "price_yearly_npr"         integer NOT NULL DEFAULT 0,
  "price_monthly_usd_cents"  integer,
  "price_yearly_usd_cents"   integer,
  "features"                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  "quotas"                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_public"                boolean NOT NULL DEFAULT true,
  "sort_order"               integer NOT NULL DEFAULT 0,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "plans_code_uq"        ON "plans" ("code");
CREATE INDEX        IF NOT EXISTS "plans_public_sort_idx" ON "plans" ("is_public", "sort_order");

-- workspaces.plan_id FK can't be added until plans exists — do it now.
DO $$ BEGIN
  ALTER TABLE "workspaces"
    ADD CONSTRAINT "workspaces_plan_id_fk"
      FOREIGN KEY ("plan_id") REFERENCES "plans"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --- workspace_members --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"   uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id"        uuid,
  "role"           workspace_role NOT NULL,
  "invited_email"  text,
  "invited_token"  text,
  "invited_at"     timestamptz,
  "accepted_at"    timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

-- Partial: only accepted memberships are unique by (workspace, user); pending
-- invites (user_id null) are not deduped here.
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspace_user_uq"
  ON "workspace_members" ("workspace_id", "user_id")
  WHERE "user_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_invited_token_uq"
  ON "workspace_members" ("invited_token")
  WHERE "invited_token" IS NOT NULL;

-- --- subscriptions ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"              uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "plan_id"                   uuid NOT NULL REFERENCES "plans"("id"),
  "status"                    subscription_status NOT NULL,
  "provider"                  billing_provider NOT NULL,
  "provider_subscription_id"  text,
  "provider_customer_id"      text,
  "billing_period"            billing_period NOT NULL DEFAULT 'monthly',
  "current_period_start"      timestamptz NOT NULL,
  "current_period_end"        timestamptz NOT NULL,
  "cancel_at_period_end"      boolean NOT NULL DEFAULT false,
  "trial_end"                 timestamptz,
  "canceled_at"               timestamptz,
  "metadata"                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "subscriptions_workspace_idx"    ON "subscriptions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "subscriptions_provider_sub_idx" ON "subscriptions" ("provider_subscription_id");
CREATE INDEX IF NOT EXISTS "subscriptions_status_expiry_idx" ON "subscriptions" ("status", "current_period_end");

-- One *live* subscription per workspace. Old canceled / expired rows stay.
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_one_live_per_workspace_uq"
  ON "subscriptions" ("workspace_id")
  WHERE "status" IN ('trialing','active','past_due','grace');

-- --- billing_events -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "billing_events" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"          uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "subscription_id"       uuid REFERENCES "subscriptions"("id") ON DELETE SET NULL,
  "provider"              billing_provider NOT NULL,
  "event_type"            text NOT NULL,
  "provider_event_id"     text NOT NULL,
  "payload"               jsonb NOT NULL,
  "signature"             text,
  "received_at"           timestamptz NOT NULL DEFAULT now(),
  "processed_at"          timestamptz,
  "processing_error"      text
);

-- Idempotency key for webhook replays.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_events_provider_event_uq"
  ON "billing_events" ("provider", "provider_event_id");

CREATE INDEX IF NOT EXISTS "billing_events_workspace_received_idx"
  ON "billing_events" ("workspace_id", "received_at");

CREATE INDEX IF NOT EXISTS "billing_events_type_idx" ON "billing_events" ("event_type");

-- --- usage_events -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "usage_events" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"   uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "metric"         text NOT NULL,
  "delta"          bigint NOT NULL,
  "subject_type"   text,
  "subject_id"     text,
  "blocked"        boolean NOT NULL DEFAULT false,
  "metadata"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "usage_events_workspace_occurred_idx"
  ON "usage_events" ("workspace_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "usage_events_metric_occurred_idx"
  ON "usage_events" ("metric", "occurred_at");

CREATE INDEX IF NOT EXISTS "usage_events_subject_idx"
  ON "usage_events" ("subject_type", "subject_id");

-- --- usage_counters -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "usage_counters" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"   uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "period_start"   date NOT NULL,
  "period_end"     date NOT NULL,
  "metric"         text NOT NULL,
  "value"          bigint NOT NULL DEFAULT 0,
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "usage_counters_workspace_period_metric_uq"
  ON "usage_counters" ("workspace_id", "period_start", "metric");

CREATE INDEX IF NOT EXISTS "usage_counters_metric_period_idx"
  ON "usage_counters" ("workspace_id", "metric", "period_start");

-- --- admin_users --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "admin_users" (
  "user_id"      uuid PRIMARY KEY,
  "role"         admin_role NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

-- --- seed plans ---------------------------------------------------------------
-- Stable UUIDs from @marketing/shared-types/billing PLAN_IDS so this seed
-- stays idempotent and code can look plans up by either id or code.
-- ON CONFLICT DO UPDATE so re-applying the migration syncs price/feature
-- changes the catalog made during development.

INSERT INTO "plans" (
  "id","code","name","description",
  "price_monthly_npr","price_yearly_npr",
  "price_monthly_usd_cents","price_yearly_usd_cents",
  "features","quotas","is_public","sort_order"
) VALUES
(
  '11111111-1111-1111-1111-000000000001','free','Free',
  'Evaluate the product. Watermarked outputs, single user.',
  0, 0, 0, 0,
  '{"asset_pipeline":false,"video_assets":false,"web_research":false,"goal_loop":false,"experiments":false,"lifecycle_sequences":false,"custom_kb_collections":false,"api_access":false,"priority_queue":false,"multi_seat":false}'::jsonb,
  '{"seats":1,"orchestrator_messages":50,"sub_agent_calls":100,"single_post_runs":10,"asset_pipeline_runs":0,"kb_embeds":50,"kb_docs":5,"kb_doc_bytes":10485760,"published_posts":5,"llm_input_tokens":200000,"llm_output_tokens":50000,"llm_cost_usd_micros":1000000}'::jsonb,
  true, 0
),
(
  '11111111-1111-1111-1111-000000000002','starter','Starter',
  'Solo marketers and freelancers.',
  2499, 24990, 2900, 29000,
  '{"asset_pipeline":false,"video_assets":false,"web_research":false,"goal_loop":false,"experiments":false,"lifecycle_sequences":false,"custom_kb_collections":false,"api_access":false,"priority_queue":false,"multi_seat":true}'::jsonb,
  '{"seats":2,"orchestrator_messages":500,"sub_agent_calls":1500,"single_post_runs":100,"asset_pipeline_runs":0,"kb_embeds":500,"kb_docs":50,"kb_doc_bytes":104857600,"published_posts":60,"llm_input_tokens":2000000,"llm_output_tokens":500000,"llm_cost_usd_micros":20000000}'::jsonb,
  true, 1
),
(
  '11111111-1111-1111-1111-000000000003','growth','Growth',
  'SMBs and small agencies. Asset pipeline + research.',
  7999, 79990, 8900, 89000,
  '{"asset_pipeline":true,"video_assets":false,"web_research":true,"goal_loop":true,"experiments":true,"lifecycle_sequences":false,"custom_kb_collections":false,"api_access":false,"priority_queue":false,"multi_seat":true}'::jsonb,
  '{"seats":5,"orchestrator_messages":3000,"sub_agent_calls":10000,"single_post_runs":500,"asset_pipeline_runs":200,"kb_embeds":5000,"kb_docs":500,"kb_doc_bytes":1073741824,"published_posts":300,"llm_input_tokens":15000000,"llm_output_tokens":3000000,"llm_cost_usd_micros":80000000}'::jsonb,
  true, 2
),
(
  '11111111-1111-1111-1111-000000000004','business','Business',
  'Agencies and mid-market. Multi-brand, video, API, lifecycle.',
  24999, 249990, 24900, 249000,
  '{"asset_pipeline":true,"video_assets":true,"web_research":true,"goal_loop":true,"experiments":true,"lifecycle_sequences":true,"custom_kb_collections":true,"api_access":true,"priority_queue":true,"multi_seat":true}'::jsonb,
  '{"seats":15,"orchestrator_messages":15000,"sub_agent_calls":50000,"single_post_runs":2500,"asset_pipeline_runs":1000,"kb_embeds":50000,"kb_docs":5000,"kb_doc_bytes":10737418240,"published_posts":1500,"llm_input_tokens":75000000,"llm_output_tokens":15000000,"llm_cost_usd_micros":250000000}'::jsonb,
  true, 3
),
(
  '11111111-1111-1111-1111-000000000005','enterprise','Enterprise',
  'Custom limits, SSO, dedicated infra, SLAs. Talk to sales.',
  75000, 750000, 75000, 750000,
  '{"asset_pipeline":true,"video_assets":true,"web_research":true,"goal_loop":true,"experiments":true,"lifecycle_sequences":true,"custom_kb_collections":true,"api_access":true,"priority_queue":true,"multi_seat":true}'::jsonb,
  '{"seats":50,"orchestrator_messages":-1,"sub_agent_calls":-1,"single_post_runs":-1,"asset_pipeline_runs":-1,"kb_embeds":-1,"kb_docs":-1,"kb_doc_bytes":-1,"published_posts":-1,"llm_input_tokens":-1,"llm_output_tokens":-1,"llm_cost_usd_micros":-1}'::jsonb,
  false, 4
)
ON CONFLICT ("id") DO UPDATE SET
  "name"                    = EXCLUDED.name,
  "description"             = EXCLUDED.description,
  "price_monthly_npr"       = EXCLUDED.price_monthly_npr,
  "price_yearly_npr"        = EXCLUDED.price_yearly_npr,
  "price_monthly_usd_cents" = EXCLUDED.price_monthly_usd_cents,
  "price_yearly_usd_cents"  = EXCLUDED.price_yearly_usd_cents,
  "features"                = EXCLUDED.features,
  "quotas"                  = EXCLUDED.quotas,
  "is_public"               = EXCLUDED.is_public,
  "sort_order"              = EXCLUDED.sort_order,
  "updated_at"              = now();


-- ============================================================
-- 0025_workspace_id_columns
-- ============================================================
-- Migration 0025: add nullable workspace_id to every tenant-bearing table.
--
-- These columns stay nullable through PR 1–2 so the migration is non-breaking.
-- PR 3 (migration 0026) backfills them from the Legacy workspace, then
-- PR 3 (migration 0027) flips them NOT NULL. Don't add app-level enforcement
-- against these columns yet; the entire surface still treats the data as
-- single-tenant.
--
-- Excluded tables (deliberately):
--   - generation_job_steps : inherits via generation_jobs.workspace_id
--   - settings             : converted to (workspace_id, key) PK in PR 4
--   - billing_events,
--     workspaces, plans,
--     workspace_members,
--     subscriptions,
--     usage_events/counters,
--     admin_users          : SaaS tables added in 0024; already tenant-aware
--
-- Idempotent: every ALTER uses IF NOT EXISTS for the column, and every CREATE
-- INDEX uses IF NOT EXISTS for the index.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0025_workspace_id_columns.sql

--> statement-breakpoint

-- campaigns
ALTER TABLE "campaigns"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "campaigns_workspace_idx" ON "campaigns" ("workspace_id");

-- content_items
ALTER TABLE "content_items"      ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "content_items" ADD CONSTRAINT "content_items_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "content_items_workspace_idx" ON "content_items" ("workspace_id");

-- content_revisions
ALTER TABLE "content_revisions"  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "content_revisions_workspace_idx" ON "content_revisions" ("workspace_id");

-- approvals
ALTER TABLE "approvals"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "approvals_workspace_idx" ON "approvals" ("workspace_id");

-- publish_jobs
ALTER TABLE "publish_jobs"       ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "publish_jobs_workspace_idx" ON "publish_jobs" ("workspace_id");

-- assets
ALTER TABLE "assets"             ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "assets_workspace_idx" ON "assets" ("workspace_id");

-- metrics
ALTER TABLE "metrics"            ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "metrics" ADD CONSTRAINT "metrics_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "metrics_workspace_idx" ON "metrics" ("workspace_id");

-- audit_log (set null on delete so audit trail outlives the workspace)
ALTER TABLE "audit_log"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "audit_log_workspace_idx" ON "audit_log" ("workspace_id", "at");

-- agent_feedback
ALTER TABLE "agent_feedback"     ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "agent_feedback_workspace_idx" ON "agent_feedback" ("workspace_id");

-- outcomes
ALTER TABLE "outcomes"           ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "outcomes_workspace_idx" ON "outcomes" ("workspace_id");

-- embeddings (security-critical; see PR 9 for dedicated role + RLS)
ALTER TABLE "embeddings"         ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "embeddings_workspace_idx" ON "embeddings" ("workspace_id");

-- brand_memory
ALTER TABLE "brand_memory"       ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "brand_memory" ADD CONSTRAINT "brand_memory_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "brand_memory_workspace_idx" ON "brand_memory" ("workspace_id");

-- brand_design_system
ALTER TABLE "brand_design_system" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "brand_design_system" ADD CONSTRAINT "brand_design_system_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "brand_design_system_workspace_idx" ON "brand_design_system" ("workspace_id");

-- brand_documents
ALTER TABLE "brand_documents"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "brand_documents" ADD CONSTRAINT "brand_documents_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "brand_documents_workspace_idx" ON "brand_documents" ("workspace_id");

-- extraction_runs
ALTER TABLE "extraction_runs"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "extraction_runs_workspace_idx" ON "extraction_runs" ("workspace_id");

-- brand_memory_drafts
ALTER TABLE "brand_memory_drafts" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "brand_memory_drafts" ADD CONSTRAINT "brand_memory_drafts_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "brand_memory_drafts_workspace_idx" ON "brand_memory_drafts" ("workspace_id");

-- generation_jobs
ALTER TABLE "generation_jobs"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "generation_jobs_workspace_idx" ON "generation_jobs" ("workspace_id");

-- workflow_runs
ALTER TABLE "workflow_runs"      ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "workflow_runs_workspace_idx" ON "workflow_runs" ("workspace_id");

-- llm_usage
ALTER TABLE "llm_usage"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "llm_usage_workspace_idx" ON "llm_usage" ("workspace_id", "occurred_at");

-- kb_collections
ALTER TABLE "kb_collections"     ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "kb_collections" ADD CONSTRAINT "kb_collections_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "kb_collections_workspace_idx" ON "kb_collections" ("workspace_id");

-- kb_documents
ALTER TABLE "kb_documents"       ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "kb_documents_workspace_idx" ON "kb_documents" ("workspace_id");

-- kb_chunks
ALTER TABLE "kb_chunks"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "kb_chunks_workspace_idx" ON "kb_chunks" ("workspace_id");

-- goal_events
ALTER TABLE "goal_events"        ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "goal_events" ADD CONSTRAINT "goal_events_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "goal_events_workspace_idx" ON "goal_events" ("workspace_id");

-- experiments
ALTER TABLE "experiments"        ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "experiments" ADD CONSTRAINT "experiments_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "experiments_workspace_idx" ON "experiments" ("workspace_id");

-- lifecycle_sequences
ALTER TABLE "lifecycle_sequences" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "lifecycle_sequences" ADD CONSTRAINT "lifecycle_sequences_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "lifecycle_sequences_workspace_idx" ON "lifecycle_sequences" ("workspace_id");

-- lifecycle_steps
ALTER TABLE "lifecycle_steps"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "lifecycle_steps" ADD CONSTRAINT "lifecycle_steps_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "lifecycle_steps_workspace_idx" ON "lifecycle_steps" ("workspace_id");


-- ============================================================
-- 0026_backfill_workspace
-- ============================================================
-- Migration 0026: backfill workspace_id on every tenant table.
--
-- Strategy:
--   1. Ensure the Legacy workspace exists (fixed uuid 00…01). If
--      scripts/bootstrap-saas.ts has already run, the owner is already a
--      real auth.users.id and we leave it alone. Otherwise we pick the
--      first auth.users row as a placeholder owner — bootstrap-saas.ts
--      can be re-run safely after this migration to upgrade memberships
--      and admin_users.
--   2. Walk the dependency graph in topological order and cascade
--      workspace_id from the parent. Tables with no parent (audit_log,
--      metrics, embeddings standalone, kb_*, brand_documents, etc.)
--      default to the Legacy workspace.
--
-- Idempotent: every UPDATE includes `WHERE workspace_id IS NULL` so
-- re-applying after partial backfill only touches rows still missing the
-- column.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0026_backfill_workspace.sql

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 1. Ensure Legacy workspace
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  legacy_owner uuid;
BEGIN
  -- Already provisioned by bootstrap-saas.ts? Skip.
  IF EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
  ) THEN
    RAISE NOTICE 'legacy workspace already exists, skipping creation';
    RETURN;
  END IF;

  -- Fall back to the first auth.users row. If there isn't one, the
  -- migration aborts — backfill is meaningless on an empty DB anyway, and
  -- the next migration's NOT NULL flip would fail on any row that did
  -- exist without an owner.
  SELECT id INTO legacy_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;

  IF legacy_owner IS NULL THEN
    -- Truly empty database (fresh deploy, no users yet). The next migration
    -- will succeed because every tenant table is also empty. Nothing to
    -- backfill; leave the Legacy workspace uncreated and exit.
    RAISE NOTICE 'no auth.users yet; skipping legacy workspace creation';
    RETURN;
  END IF;

  INSERT INTO public.workspaces (id, slug, name, owner_user_id, plan_id, plan_overridden_until)
  VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'legacy',
    'Legacy',
    legacy_owner,
    '11111111-1111-1111-1111-000000000005'::uuid,  -- enterprise
    '2099-01-01T00:00:00Z'::timestamptz
  );

  -- Make the bootstrap owner a member too, so they can actually access
  -- the workspace from the UI.
  INSERT INTO public.workspace_members (workspace_id, user_id, role, accepted_at)
  VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    legacy_owner,
    'owner',
    now()
  )
  ON CONFLICT DO NOTHING;
END $$;

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 2. Backfill in topological order
-- ----------------------------------------------------------------------------
-- Skip cleanly when there's no Legacy workspace (empty DB case above).

DO $$
DECLARE
  legacy uuid := '00000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = legacy) THEN
    RAISE NOTICE 'no legacy workspace; skipping backfill';
    RETURN;
  END IF;

  -- Roots (no parent / parentless data) default to Legacy.
  UPDATE public.campaigns        SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.brand_documents  SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.extraction_runs  SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.metrics          SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.audit_log        SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.embeddings       SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.llm_usage        SET workspace_id = legacy WHERE workspace_id IS NULL;

  -- Children of campaigns (1-level).
  UPDATE public.content_items ci
     SET workspace_id = COALESCE(c.workspace_id, legacy)
    FROM public.campaigns c
   WHERE ci.workspace_id IS NULL AND ci.campaign_id = c.id;

  UPDATE public.experiments e
     SET workspace_id = COALESCE(c.workspace_id, legacy)
    FROM public.campaigns c
   WHERE e.workspace_id IS NULL AND e.campaign_id = c.id;

  UPDATE public.goal_events g
     SET workspace_id = COALESCE(c.workspace_id, legacy)
    FROM public.campaigns c
   WHERE g.workspace_id IS NULL AND g.campaign_id = c.id;

  UPDATE public.lifecycle_sequences l
     SET workspace_id = COALESCE(c.workspace_id, legacy)
    FROM public.campaigns c
   WHERE l.workspace_id IS NULL AND l.campaign_id = c.id;

  -- brand_memory / brand_design_system / kb_collections all have a
  -- nullable campaign_id (global default rows). Resolve through campaign
  -- when present, else Legacy.
  UPDATE public.brand_memory bm
     SET workspace_id = CASE
       WHEN bm.campaign_id IS NULL THEN legacy
       ELSE (SELECT workspace_id FROM public.campaigns WHERE id = bm.campaign_id)
     END
   WHERE bm.workspace_id IS NULL;
  UPDATE public.brand_memory SET workspace_id = legacy WHERE workspace_id IS NULL;

  UPDATE public.brand_design_system bds
     SET workspace_id = CASE
       WHEN bds.campaign_id IS NULL THEN legacy
       ELSE (SELECT workspace_id FROM public.campaigns WHERE id = bds.campaign_id)
     END
   WHERE bds.workspace_id IS NULL;
  UPDATE public.brand_design_system SET workspace_id = legacy WHERE workspace_id IS NULL;

  UPDATE public.kb_collections kc
     SET workspace_id = CASE
       WHEN kc.campaign_id IS NULL THEN legacy
       ELSE (SELECT workspace_id FROM public.campaigns WHERE id = kc.campaign_id)
     END
   WHERE kc.workspace_id IS NULL;
  UPDATE public.kb_collections SET workspace_id = legacy WHERE workspace_id IS NULL;

  -- generation_jobs / workflow_runs reference campaigns + content_items
  -- via *nullable* FKs (set null on delete). Backfill via campaign first,
  -- then content's campaign, then Legacy.
  UPDATE public.generation_jobs gj
     SET workspace_id = COALESCE(c.workspace_id, ci.workspace_id, legacy)
    FROM public.campaigns c
   FULL OUTER JOIN public.content_items ci ON ci.campaign_id = c.id
   WHERE gj.workspace_id IS NULL
     AND (gj.campaign_id = c.id OR gj.content_id = ci.id);
  UPDATE public.generation_jobs SET workspace_id = legacy WHERE workspace_id IS NULL;

  UPDATE public.workflow_runs wr
     SET workspace_id = COALESCE(c.workspace_id, ci.workspace_id, legacy)
    FROM public.campaigns c
   FULL OUTER JOIN public.content_items ci ON ci.campaign_id = c.id
   WHERE wr.workspace_id IS NULL
     AND (wr.campaign_id = c.id OR wr.content_id = ci.id);
  UPDATE public.workflow_runs SET workspace_id = legacy WHERE workspace_id IS NULL;

  -- Children of content_items (2-level: content_items already populated).
  UPDATE public.content_revisions cr
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE cr.workspace_id IS NULL AND cr.content_id = ci.id;

  UPDATE public.approvals a
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE a.workspace_id IS NULL AND a.content_id = ci.id;

  UPDATE public.publish_jobs pj
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE pj.workspace_id IS NULL AND pj.content_id = ci.id;

  UPDATE public.assets ass
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE ass.workspace_id IS NULL AND ass.content_id = ci.id;
  UPDATE public.assets SET workspace_id = legacy WHERE workspace_id IS NULL;

  UPDATE public.agent_feedback af
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE af.workspace_id IS NULL AND af.content_id = ci.id;

  UPDATE public.outcomes o
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE o.workspace_id IS NULL AND o.content_id = ci.id;

  -- Children of extraction_runs.
  UPDATE public.brand_memory_drafts bmd
     SET workspace_id = COALESCE(er.workspace_id, legacy)
    FROM public.extraction_runs er
   WHERE bmd.workspace_id IS NULL AND bmd.run_id = er.id;

  -- KB cascade: documents → collections, chunks → documents.
  UPDATE public.kb_documents kd
     SET workspace_id = COALESCE(kc.workspace_id, legacy)
    FROM public.kb_collections kc
   WHERE kd.workspace_id IS NULL AND kd.collection_id = kc.id;

  UPDATE public.kb_chunks kch
     SET workspace_id = COALESCE(kd.workspace_id, legacy)
    FROM public.kb_documents kd
   WHERE kch.workspace_id IS NULL AND kch.document_id = kd.id;

  -- Lifecycle steps inherit from sequences.
  UPDATE public.lifecycle_steps ls
     SET workspace_id = COALESCE(lseq.workspace_id, legacy)
    FROM public.lifecycle_sequences lseq
   WHERE ls.workspace_id IS NULL AND ls.sequence_id = lseq.id;
END $$;

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 3. Sanity check: report any still-null rows. Migration 0027's NOT NULL
--    flip will fail on these, so it's better to surface them now.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  missing_count integer;
  table_name text;
  -- Every table where we expect workspace_id to be NOT NULL after 0027.
  -- audit_log and billing_events stay nullable by design (FK set null).
  tables text[] := ARRAY[
    'campaigns','content_items','content_revisions','approvals','publish_jobs',
    'assets','metrics','agent_feedback','outcomes','embeddings',
    'brand_memory','brand_design_system','brand_documents','extraction_runs',
    'brand_memory_drafts','generation_jobs','workflow_runs','llm_usage',
    'kb_collections','kb_documents','kb_chunks','goal_events','experiments',
    'lifecycle_sequences','lifecycle_steps'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE workspace_id IS NULL', table_name)
      INTO missing_count;
    IF missing_count > 0 THEN
      RAISE WARNING 'table %.workspace_id still null on % rows', table_name, missing_count;
    END IF;
  END LOOP;
END $$;


-- ============================================================
-- 0027_workspace_id_not_null
-- ============================================================
-- Migration 0027: flip workspace_id to NOT NULL on every tenant table.
--
-- DO NOT APPLY THIS UNTIL PR 5 HAS LANDED. The application code only starts
-- setting workspace_id on every INSERT once PR 5 (entitlement + metering)
-- plumbs context through the orchestrator, workflows, and the agents
-- package. Applying 0027 before then would cause every llm_usage /
-- workflow_run / generation_job insert to fail in production.
--
-- Apply order during PR 5 rollout:
--   1. Deploy PR 5 (workspace_id is now passed everywhere; the Drizzle
--      column type is flipped to .notNull() in the same PR).
--   2. Apply this migration 0027.
--   3. Run the smoke test: a chat turn should produce an llm_usage row
--      with a non-null workspace_id.
--
-- Run AFTER 0026_backfill_workspace.sql. If any row is still null at this
-- point the ALTER aborts — that's the desired safety net.
--
-- audit_log and billing_events stay nullable because their workspace FK is
-- ON DELETE SET NULL (audit trail and webhook ledger must survive workspace
-- deletion).
--
-- Also re-scopes slug uniqueness on:
--   - campaigns.slug          → unique within (workspace_id, slug)
--   - kb_collections.slug     → unique within (workspace_id, slug)
-- so two tenants can each own a "summer-launch" campaign or "brand"
-- collection without colliding.
--
-- settings.key stays as a global PK in this migration; PR 4 converts it
-- to (workspace_id, key) with a partial unique on global rows.
--
-- Idempotent: ALTER COLUMN SET NOT NULL is a no-op when already set, and
-- CREATE INDEX uses IF NOT EXISTS / DROP INDEX uses IF EXISTS.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0027_workspace_id_not_null.sql

--> statement-breakpoint

ALTER TABLE "campaigns"            ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "content_items"        ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "content_revisions"    ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "approvals"            ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "publish_jobs"         ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "assets"               ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "metrics"              ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "agent_feedback"       ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "outcomes"             ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "embeddings"           ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "brand_memory"         ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "brand_design_system"  ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "brand_documents"      ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "extraction_runs"      ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "brand_memory_drafts"  ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "generation_jobs"      ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "workflow_runs"        ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "llm_usage"            ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "kb_collections"       ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "kb_documents"         ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "kb_chunks"            ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "goal_events"          ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "experiments"          ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "lifecycle_sequences"  ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "lifecycle_steps"      ALTER COLUMN "workspace_id" SET NOT NULL;

--> statement-breakpoint

-- Re-scope slug uniqueness to (workspace_id, slug).
-- Both indexes were originally created on the slug alone (see migration 0001
-- for campaigns and 0015 for kb_collections). The replacement happens in
-- two steps so an in-flight INSERT during the swap can't see *zero*
-- protective indexes — we create the new one first, then drop the old.

CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_workspace_slug_uq"
  ON "campaigns" ("workspace_id", "slug");
DROP INDEX IF EXISTS "campaigns_slug_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "kb_collections_workspace_slug_uq"
  ON "kb_collections" ("workspace_id", "slug");
DROP INDEX IF EXISTS "kb_collections_slug_uq";


-- ============================================================
-- 0028_settings_per_workspace
-- ============================================================
-- Migration 0028: convert `settings` to per-workspace + global fallback.
--
-- Layout after this migration:
--   * `workspace_id` uuid — NULL = global default row
--   * `key`          text  — setting name
--   * PK: (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'), key)
--     implemented as a unique index because Postgres PKs can't directly
--     contain a NULL-bearing column even with coalesce
--   * partial unique on (key) where workspace_id IS NULL — enforces "exactly
--     one global row per key" so the JS-level fallback merge is well-defined
--
-- Read pattern (handled in apps/web/app/api/settings/route.ts):
--   1. SELECT * FROM settings WHERE workspace_id = $ctx
--   2. SELECT * FROM settings WHERE workspace_id IS NULL AND key NOT IN (those from #1)
--   3. Merge — workspace value wins on conflict.
--
-- All existing rows are global (the table is single-tenant pre-PR 4), so the
-- backfill is: leave workspace_id NULL on everything. New workspace-scoped
-- entries arrive when a tenant overrides a global setting.
--
-- Idempotent.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0028_settings_per_workspace.sql

--> statement-breakpoint

-- 1. Add workspace_id column (nullable; global rows stay NULL).
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

DO $$ BEGIN
  ALTER TABLE "settings"
    ADD CONSTRAINT "settings_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

-- 2. Drop the old PK on (key) so two rows can share the same key as long as
--    they differ in workspace_id.
ALTER TABLE "settings" DROP CONSTRAINT IF EXISTS "settings_pkey";

--> statement-breakpoint

-- 3. Composite uniqueness on (coalesce(workspace_id, zero-uuid), key).
--    Using coalesce lets us treat a global row (NULL) and a workspace row
--    as distinct entries — and "at most one of each" — in a single index.
CREATE UNIQUE INDEX IF NOT EXISTS "settings_workspace_key_pk"
  ON "settings" (
    COALESCE("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "key"
  );

-- Lookup index (not unique) for the workspace-only read path.
CREATE INDEX IF NOT EXISTS "settings_workspace_key_idx"
  ON "settings" ("workspace_id", "key");

-- 4. Partial unique for the global fallback row (one per key). Defensive —
--    the coalesce index above already enforces this, but having a dedicated
--    constraint makes the intent obvious to anyone reading \d settings.
CREATE UNIQUE INDEX IF NOT EXISTS "settings_global_key_uq"
  ON "settings" ("key")
  WHERE "workspace_id" IS NULL;


-- ============================================================
-- 0029_visual_direction_upstream
-- ============================================================
-- Migration 0029: move visual direction upstream from the Art Director.
--
-- visual_identity (campaigns): the Strategist now sets a campaign-level
-- visual identity (recurring motifs, color/mood, art style, banned aesthetics)
-- alongside the calendar. Reused across every post in the campaign.
--
-- image_brief (content_items): the Content agent now emits a per-post image
-- brief (subject, composition, mood, overlay text, must-show / must-not-show)
-- alongside the body copy. The Art Director becomes a refiner that translates
-- imageBrief + visual_identity into a single optimized prompt — instead of
-- guessing the visual from the body alone.
--
-- Both columns are nullable jsonb so existing campaigns and content rows keep
-- working; the Art Director falls back to body-only inference when missing.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0029_visual_direction_upstream.sql

--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "visual_identity" jsonb;

--> statement-breakpoint

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "image_brief" jsonb;


-- ============================================================
-- 0030_researcher_step_name
-- ============================================================
-- Migration 0030: add researcher step + research job kind.
--
-- Until now the chat's run_researcher tool was the only sub-agent not wired
-- through generationTracker.recordStep, because the pg enum lacked the value.
-- That meant invocations left no trail in /creation-workflow and the chat
-- never detached to background-tracking mode. Adding the enum values lets the
-- orchestrator record the step like every other sub-agent and tag the parent
-- generation_jobs row with a research-specific kind.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0030_researcher_step_name.sql

ALTER TYPE "generation_step_name" ADD VALUE IF NOT EXISTS 'researcher';

--> statement-breakpoint

ALTER TYPE "generation_job_kind" ADD VALUE IF NOT EXISTS 'research';


-- ============================================================
-- 0031_workspace_scoped_uniques
-- ============================================================
-- Migration 0031: make the remaining slug-uniqueness constraints workspace-aware.
--
-- Background. Migrations 0024–0028 added `workspace_id` to every tenant table
-- but the older unique indexes that predate multi-tenancy still treat slugs as
-- globally unique. Once two workspaces exist, those indexes:
--   * block legitimate writes (workspace B can't reuse a campaign slug that
--     workspace A already uses), and
--   * worse, cause `INSERT … ON CONFLICT (slug) DO UPDATE` to silently update
--     the other workspace's row.
--
-- Tables addressed:
--   * campaigns                 — slug
--   * brand_memory              — slug (split: campaign_id IS NULL vs NOT NULL)
--   * brand_design_system       — slug (same split)
--   * kb_collections            — slug
--
-- Pattern: each old unique index is replaced by an equivalent one that adds
-- `workspace_id` as the leading column. Read paths are unaffected — they
-- already filter by workspace_id at the app layer.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0031_workspace_scoped_uniques.sql
--
-- Idempotent.

--> statement-breakpoint

-- campaigns: slug uniqueness is per-workspace.
DROP INDEX IF EXISTS "campaigns_slug_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_workspace_slug_uq"
  ON "campaigns" ("workspace_id", "slug");

--> statement-breakpoint

-- brand_memory: the two existing partial indexes only differ in the
-- campaign_id predicate; both need workspace_id as the leading column.
DROP INDEX IF EXISTS "brand_memory_slug_global_uq";
DROP INDEX IF EXISTS "brand_memory_slug_campaign_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "brand_memory_workspace_slug_global_uq"
  ON "brand_memory" ("workspace_id", "slug")
  WHERE "campaign_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "brand_memory_workspace_slug_campaign_uq"
  ON "brand_memory" ("workspace_id", "slug", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

--> statement-breakpoint

-- brand_design_system: same split as brand_memory.
DROP INDEX IF EXISTS "brand_design_system_slug_global_uq";
DROP INDEX IF EXISTS "brand_design_system_slug_campaign_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_system_workspace_slug_global_uq"
  ON "brand_design_system" ("workspace_id", "slug")
  WHERE "campaign_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_system_workspace_slug_campaign_uq"
  ON "brand_design_system" ("workspace_id", "slug", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

--> statement-breakpoint

-- kb_collections: collection slug is per-workspace.
DROP INDEX IF EXISTS "kb_collections_slug_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "kb_collections_workspace_slug_uq"
  ON "kb_collections" ("workspace_id", "slug");


-- ============================================================
-- 0032_content_needs_video
-- ============================================================
-- Migration 0032: per-post video-generation toggle.
--
-- Adds `needs_video` to content_items, mirroring `needs_images` (migration
-- 0010). When false, the submit-time hook and the workflow's
-- kickVideoVariantStep skip Veo entirely. When true (default), behaviour is
-- unchanged: the existing `contentTypeWantsVideo()` gate (linkedin / x_post /
-- x_thread only) still applies on top, so non-video types never produce a
-- clip regardless of the flag.
--
-- Toggling false -> true via PATCH /api/content/:id re-triggers a video kick
-- if no video asset exists yet, matching the needs_images pattern.

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "needs_video" boolean NOT NULL DEFAULT true;


-- ============================================================
-- 0033_workspace_market_context
-- ============================================================
-- Migration 0033: workspace market context (Place of the 4 Ps).
--
-- Structured fields the strategist needs so generated content stops being
-- geo-generic: which country/region the business sells into, which languages
-- to write in, which channels to prioritise. Freeform nuance (pricing story,
-- cultural notes, festival calendar, promotion mix) lives in a new
-- `market.context` row in `brand_memory` — added in code, not schema, because
-- brand_memory already accepts arbitrary slugs.
--
-- All columns are nullable. Empty workspaces fall back to the old behaviour
-- (no Market block injected) so nothing breaks for tenants that haven't
-- filled this in yet.

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "primary_country" text;

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "target_regions" text[];

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "languages" text[];

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "primary_channels" text[];



-- ============================================================
-- infra/supabase/policies.sql
-- ============================================================
-- Row Level Security policies + the publish-gate trigger.
-- Apply via Supabase SQL editor after `pnpm db:push` lands the schema.
-- Plan §3 — RLS is non-negotiable.

-- ---------------------------------------------------------------------------
-- 1. Enable RLS on every table.
-- ---------------------------------------------------------------------------

alter table campaigns          enable row level security;
alter table content_items      enable row level security;
alter table content_revisions  enable row level security;
alter table approvals          enable row level security;
alter table publish_jobs       enable row level security;
alter table assets             enable row level security;
alter table metrics            enable row level security;
alter table audit_log          enable row level security;
alter table settings           enable row level security;
-- Phase 11 tables
alter table agent_feedback     enable row level security;
alter table outcomes           enable row level security;
-- Phase 11.1 generic embeddings table (includes content vectors; legacy content_embeddings removed)
alter table embeddings         enable row level security;
-- NOTE: brand_memory RLS is bundled into migration 0004_brand_memory.sql.
-- Tables added after 0003 ship their RLS inside the migration (idempotent
-- via DROP POLICY IF EXISTS) so upgrades only need to apply migrations.

-- ---------------------------------------------------------------------------
-- 2. Authenticated team members can read everything.
--    The service role bypasses RLS implicitly; agents use the service role.
-- ---------------------------------------------------------------------------

create policy "team_read_campaigns"          on campaigns          for select to authenticated using (true);
create policy "team_read_content_items"      on content_items      for select to authenticated using (true);
create policy "team_read_content_revisions"  on content_revisions  for select to authenticated using (true);
create policy "team_read_approvals"          on approvals          for select to authenticated using (true);
create policy "team_read_publish_jobs"       on publish_jobs       for select to authenticated using (true);
create policy "team_read_assets"             on assets             for select to authenticated using (true);
create policy "team_read_metrics"            on metrics            for select to authenticated using (true);
create policy "team_read_audit_log"          on audit_log          for select to authenticated using (true);
create policy "team_read_settings"           on settings           for select to authenticated using (true);
-- Phase 11
create policy "team_read_agent_feedback"     on agent_feedback     for select to authenticated using (true);
create policy "team_read_outcomes"           on outcomes           for select to authenticated using (true);
create policy "team_read_embeddings"         on embeddings         for select to authenticated using (true);
-- brand_memory read policy lives in migration 0004_brand_memory.sql.

-- ---------------------------------------------------------------------------
-- 3. Editable tables — authenticated team members can write subject to the
--    state-machine rules enforced server-side. We do NOT expose
--    publish_jobs / audit_log / settings to client writes.
-- ---------------------------------------------------------------------------

create policy "team_write_campaigns"          on campaigns          for all to authenticated using (true) with check (true);
create policy "team_write_content_items"      on content_items      for all to authenticated using (true) with check (true);
create policy "team_write_content_revisions"  on content_revisions  for all to authenticated using (true) with check (true);
create policy "team_write_approvals"          on approvals          for all to authenticated using (true) with check (true);
create policy "team_write_assets"             on assets             for all to authenticated using (true) with check (true);

-- audit_log, publish_jobs, settings, agent_feedback, outcomes, embeddings:
-- NO insert/update/delete policy for authenticated. Only the service role can mutate them.

-- ---------------------------------------------------------------------------
-- 4. The publish-gate trigger. Plan §3 — the entire safety story rests on
--    this rule, so we enforce it twice: once in the Route Handler, once here.
-- ---------------------------------------------------------------------------

create or replace function enforce_publish_gate()
returns trigger
language plpgsql
as $$
declare
  current_status content_status;
begin
  select status into current_status
  from content_items
  where id = NEW.content_id;

  if current_status is null then
    raise exception 'publish_jobs: content_id % does not exist', NEW.content_id;
  end if;

  -- approved is the canonical pre-publish state. scheduled is allowed because
  -- the API transitions content_items to scheduled at the same time as
  -- inserting a publish_jobs row.
  if current_status not in ('approved', 'scheduled') then
    raise exception
      'publish_jobs: content % is %, must be approved before scheduling',
      NEW.content_id, current_status
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_publish_gate on publish_jobs;
create trigger trg_enforce_publish_gate
before insert on publish_jobs
for each row
execute function enforce_publish_gate();

-- ---------------------------------------------------------------------------
-- 5. 24-hour same-channel republish guard (Phase 9 Day 2).
--    Belt for the Route Handler check.
-- ---------------------------------------------------------------------------

create or replace function enforce_republish_window()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from publish_jobs
    where content_id = NEW.content_id
      and channel = NEW.channel
      and status in ('queued', 'running', 'succeeded')
      and created_at > now() - interval '24 hours'
  ) then
    raise exception
      'publish_jobs: content % already published to % within last 24h',
      NEW.content_id, NEW.channel
      using errcode = 'unique_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_republish_window on publish_jobs;
create trigger trg_enforce_republish_window
before insert on publish_jobs
for each row
execute function enforce_republish_window();


-- ============================================================
-- infra/supabase/views.sql
-- ============================================================
-- Analyst rollups. Phase 8 Day 2.
-- These are pure SQL views over Postgres; no analytics warehouse needed at
-- this scale.

create or replace view campaign_performance as
select
  c.id                              as campaign_id,
  c.slug                            as campaign_slug,
  count(distinct ci.id)             as content_items,
  count(distinct case when ci.status = 'published' then ci.id end) as published_items,
  count(distinct pj.id) filter (where pj.status = 'succeeded') as successful_publishes,
  count(distinct pj.id) filter (where pj.status = 'failed')    as failed_publishes
from campaigns c
left join content_items ci on ci.campaign_id = c.id
left join publish_jobs  pj on pj.content_id  = ci.id
group by c.id, c.slug;

create or replace view stage_performance as
select
  ci.stage,
  count(*)                                 as content_count,
  count(*) filter (where ci.status = 'published') as published_count,
  avg(extract(epoch from (ci.published_at - ci.created_at)) / 3600.0)::numeric(10, 2)
                                           as avg_hours_to_publish
from content_items ci
where ci.status = 'published'
group by ci.stage;

create or replace view channel_performance as
select
  pj.channel,
  count(*)                                       as job_count,
  count(*) filter (where pj.status = 'succeeded') as succeeded,
  count(*) filter (where pj.status = 'failed')    as failed,
  avg(pj.attempts)::numeric(10, 2)                as avg_attempts
from publish_jobs pj
group by pj.channel;


-- ============================================================
-- infra/supabase/seed.sql
-- ============================================================
-- Seed defaults. Run once after migrations.

insert into settings (key, value) values
  ('kill_switch', 'false'::jsonb),
  ('channel_caps', '{"linkedin": 5, "x": 20, "internal_blog": 50, "email_hubspot": 5, "email_mailchimp": 5}'::jsonb),
  ('approval_policy', '{"mode": "single", "channels": []}'::jsonb)
on conflict (key) do nothing;

