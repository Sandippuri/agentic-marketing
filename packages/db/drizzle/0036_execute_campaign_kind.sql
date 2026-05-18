-- Migration 0036: add 'execute_campaign' to the workflow run kind enum.
--
-- The `campaign` kind runs the Strategist to draft a brief + calendar.
-- `execute_campaign` is the missing follow-up step: take a campaign whose
-- calendar already exists and fan out one single-post workflow per item so
-- the actual content rows get created. Before this, asking the Strategist
-- "generate the 14 posts" just produced prose and persisted nothing — see
-- workflows/execute-campaign.ts.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0036_execute_campaign_kind.sql

ALTER TYPE "generation_job_kind" ADD VALUE IF NOT EXISTS 'execute_campaign';
