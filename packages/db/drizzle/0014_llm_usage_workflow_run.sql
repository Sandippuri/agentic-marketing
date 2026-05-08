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
