-- Migration 0023: persist the Asset Judge's per-candidate score on the asset
-- row itself, so the learning loop (Phase D) can query "high-scoring assets
-- that also performed well" without re-scoring.
--
-- judge_score holds the full structured payload (axes + verdict + reason) as
-- JSONB so the schema can evolve without further migrations.
-- judge_total is denormalized as a scalar for fast filtering / sorting /
-- composite indexes against outcomes data.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0023_asset_judge_scores.sql

--> statement-breakpoint

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "judge_score"     jsonb,
  ADD COLUMN IF NOT EXISTS "judge_total"     numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "judge_verdict"   text;

-- Sort/filter index — high-scoring assets are what get promoted into the KB
-- in the nightly job, so the most common query is "ORDER BY judge_total DESC
-- WHERE judge_verdict='accept'".
CREATE INDEX IF NOT EXISTS "assets_judge_total_idx"
  ON "assets" ("judge_total" DESC NULLS LAST);
