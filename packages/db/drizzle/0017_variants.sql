-- Migration 0017: A/B variants + SEO metadata on content_items.
--
-- variant_group: shared uuid for items belonging to the same A/B test
-- variant_index: 0-based ordinal within the group (variant A=0, B=1, …)
-- experiment_id: FK populated when an experiments row is created in 0018
-- seo_meta:      structured title/description/keywords/h-tags written by
--                the SEO sub-agent (Phase 3); free-form jsonb to allow
--                schema evolution without migrations.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0017_variants.sql

--> statement-breakpoint

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "variant_group"  uuid,
  ADD COLUMN IF NOT EXISTS "variant_index"  integer,
  ADD COLUMN IF NOT EXISTS "experiment_id"  uuid,
  ADD COLUMN IF NOT EXISTS "seo_meta"       jsonb;

CREATE INDEX IF NOT EXISTS "content_items_variant_group_idx"
  ON "content_items" ("variant_group");
CREATE INDEX IF NOT EXISTS "content_items_experiment_idx"
  ON "content_items" ("experiment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "content_items_experiment_variant_uq"
  ON "content_items" ("experiment_id", "variant_index")
  WHERE "experiment_id" IS NOT NULL AND "variant_index" IS NOT NULL;
