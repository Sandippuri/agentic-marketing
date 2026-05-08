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
