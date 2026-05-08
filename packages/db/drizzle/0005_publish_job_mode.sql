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
