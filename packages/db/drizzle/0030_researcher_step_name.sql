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
