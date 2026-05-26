-- Migration 0039: Generalize llm_usage into ai_usage to track image, video,
-- and embedding spend alongside LLM token usage.
--
-- Why: image (Gemini / Sora / Flux), video (Veo / Sora 2 / Wan), and embedding
-- calls were previously invisible to cost dashboards. They can be a large
-- share of spend per workspace — videos especially. After this migration,
-- every AI provider hit goes through the same recorder and the same
-- cost_usd column, so existing aggregate queries (sum cost_usd) continue
-- to give a correct total without UNIONing extra tables.
--
-- Shape change:
--   - Rename table: llm_usage -> ai_usage (and indexes).
--   - Add kind ('llm' | 'embedding' | 'image' | 'video'), units
--     ('tokens' | 'images' | 'seconds'), and unit_count for non-token kinds.
--   - Add cache_creation_tokens (Anthropic prompt-cache first-write count
--     was previously dropped — only cache_read was being captured).
--   - Add metadata jsonb for provider-specific extras (replicate prediction
--     id, aspect ratio, model variant, raw provider metadata blob).
--
-- Existing rows are backfilled with kind='llm', units='tokens', which keeps
-- legacy LLM aggregate queries unchanged.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0039_ai_usage.sql

-- Idempotent: some DBs had this migration applied manually before the runner
-- started tracking it in _schema_migrations, so the rename target may already
-- exist. Every statement below is a no-op when the change is already in place.

ALTER TABLE IF EXISTS "llm_usage" RENAME TO "ai_usage";

ALTER INDEX IF EXISTS "llm_usage_occurred_at_idx"   RENAME TO "ai_usage_occurred_at_idx";
ALTER INDEX IF EXISTS "llm_usage_model_idx"         RENAME TO "ai_usage_model_idx";
ALTER INDEX IF EXISTS "llm_usage_agent_idx"         RENAME TO "ai_usage_agent_idx";
ALTER INDEX IF EXISTS "llm_usage_workflow_run_idx"  RENAME TO "ai_usage_workflow_run_idx";
ALTER INDEX IF EXISTS "llm_usage_workspace_idx"     RENAME TO "ai_usage_workspace_idx";

ALTER TABLE "ai_usage"
  ADD COLUMN IF NOT EXISTS "kind"                  text     NOT NULL DEFAULT 'llm',
  ADD COLUMN IF NOT EXISTS "units"                 text     NOT NULL DEFAULT 'tokens',
  ADD COLUMN IF NOT EXISTS "unit_count_input"      integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "unit_count_output"     integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cache_creation_tokens" integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "metadata"              jsonb    NOT NULL DEFAULT '{}'::jsonb;

-- Existing rows: unit_count_input = input_tokens, unit_count_output = output_tokens
-- so the unified columns are usable for cross-kind aggregates without special
-- casing the historical LLM rows.
UPDATE "ai_usage"
SET unit_count_input  = input_tokens,
    unit_count_output = output_tokens
WHERE kind = 'llm';

CREATE INDEX IF NOT EXISTS "ai_usage_kind_idx" ON "ai_usage" ("kind", "occurred_at");
