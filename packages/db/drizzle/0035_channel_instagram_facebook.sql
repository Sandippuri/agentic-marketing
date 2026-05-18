-- Migration 0035: add instagram + facebook to the channel enum.
--
-- The TypeScript CHANNELS list (packages/shared-types/src/index.ts) grew to
-- include 'instagram' and 'facebook' in commits a11f637 / e275e59, but the
-- Postgres enum was never updated. Any insert/filter using those values
-- (e.g. find_similar_content called by the Strategist) fails with
--   PostgresError 22P02: invalid input value for enum channel: "instagram"
-- which causes /api/content/similar to 500 and the chat to spin forever
-- inside the strategist sub-agent's retry loop.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0035_channel_instagram_facebook.sql

ALTER TYPE "channel" ADD VALUE IF NOT EXISTS 'instagram';

--> statement-breakpoint

ALTER TYPE "channel" ADD VALUE IF NOT EXISTS 'facebook';
