-- Migration 0008: campaign-scoped brand memory and design system.
--
-- Until now `brand_memory` and `brand_design_system` were global singletons
-- (one row per slug). Campaigns may now carry their own brand voice and
-- design overrides. The global rows (campaign_id IS NULL) remain the
-- default; a row with the same slug AND a non-null campaign_id wins for
-- that campaign.
--
-- Resolution at read time:
--   SELECT ... WHERE slug = :slug AND (campaign_id = :id OR campaign_id IS NULL)
--   ORDER BY campaign_id NULLS LAST LIMIT 1
--
-- Unique constraints:
--   - At most one global row per slug    (campaign_id IS NULL)
--   - At most one row per (slug, campaign) (campaign_id IS NOT NULL)
-- Postgres treats NULL as distinct in regular UNIQUE constraints, so we
-- enforce both with two partial unique indexes.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0008_campaign_scoped_brand.sql

--> statement-breakpoint

ALTER TABLE "brand_memory"
  ADD COLUMN IF NOT EXISTS "campaign_id" uuid
  REFERENCES "campaigns"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "brand_memory"
  DROP CONSTRAINT IF EXISTS "brand_memory_slug_uq";

--> statement-breakpoint

DROP INDEX IF EXISTS "brand_memory_slug_uq";

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brand_memory_slug_global_uq"
  ON "brand_memory" ("slug")
  WHERE "campaign_id" IS NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brand_memory_slug_campaign_uq"
  ON "brand_memory" ("slug", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brand_memory_campaign_idx"
  ON "brand_memory" ("campaign_id");

--> statement-breakpoint

ALTER TABLE "brand_design_system"
  ADD COLUMN IF NOT EXISTS "campaign_id" uuid
  REFERENCES "campaigns"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "brand_design_system"
  DROP CONSTRAINT IF EXISTS "brand_design_system_slug_uq";

--> statement-breakpoint

DROP INDEX IF EXISTS "brand_design_system_slug_uq";

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_system_slug_global_uq"
  ON "brand_design_system" ("slug")
  WHERE "campaign_id" IS NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_system_slug_campaign_uq"
  ON "brand_design_system" ("slug", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brand_design_system_campaign_idx"
  ON "brand_design_system" ("campaign_id");
