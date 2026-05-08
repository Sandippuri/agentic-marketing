-- Migration 0003: Remove legacy content_embeddings (superseded by `embeddings`, source_type='content').
-- Apply after `0002_generic_embeddings` migration (data copied in 0002).
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0003_drop_content_embeddings.sql

--> statement-breakpoint

DROP TABLE IF EXISTS "content_embeddings";
