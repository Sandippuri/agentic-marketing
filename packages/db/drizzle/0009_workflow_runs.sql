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
