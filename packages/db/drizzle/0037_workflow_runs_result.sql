-- Migration 0037: add workflow_runs.result for terminal output.
--
-- Until now finishRun only wrote status/error to the row, so the workflow's
-- return value (e.g. the Strategist's 14-post text) was discarded after the
-- run completed. If the workflow created no campaign / content row, the
-- text was effectively lost — only visible in the Vercel trace UI.
--
-- This column captures the workflow's terminal result so it's recoverable
-- alongside the run row that produced it.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0037_workflow_runs_result.sql

ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "result" jsonb;
