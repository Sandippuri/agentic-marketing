-- Migration 0031: make the remaining slug-uniqueness constraints workspace-aware.
--
-- Background. Migrations 0024–0028 added `workspace_id` to every tenant table
-- but the older unique indexes that predate multi-tenancy still treat slugs as
-- globally unique. Once two workspaces exist, those indexes:
--   * block legitimate writes (workspace B can't reuse a campaign slug that
--     workspace A already uses), and
--   * worse, cause `INSERT … ON CONFLICT (slug) DO UPDATE` to silently update
--     the other workspace's row.
--
-- Tables addressed:
--   * campaigns                 — slug
--   * brand_memory              — slug (split: campaign_id IS NULL vs NOT NULL)
--   * brand_design_system       — slug (same split)
--   * kb_collections            — slug
--
-- Pattern: each old unique index is replaced by an equivalent one that adds
-- `workspace_id` as the leading column. Read paths are unaffected — they
-- already filter by workspace_id at the app layer.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0031_workspace_scoped_uniques.sql
--
-- Idempotent.

--> statement-breakpoint

-- campaigns: slug uniqueness is per-workspace.
DROP INDEX IF EXISTS "campaigns_slug_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_workspace_slug_uq"
  ON "campaigns" ("workspace_id", "slug");

--> statement-breakpoint

-- brand_memory: the two existing partial indexes only differ in the
-- campaign_id predicate; both need workspace_id as the leading column.
DROP INDEX IF EXISTS "brand_memory_slug_global_uq";
DROP INDEX IF EXISTS "brand_memory_slug_campaign_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "brand_memory_workspace_slug_global_uq"
  ON "brand_memory" ("workspace_id", "slug")
  WHERE "campaign_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "brand_memory_workspace_slug_campaign_uq"
  ON "brand_memory" ("workspace_id", "slug", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

--> statement-breakpoint

-- brand_design_system: same split as brand_memory.
DROP INDEX IF EXISTS "brand_design_system_slug_global_uq";
DROP INDEX IF EXISTS "brand_design_system_slug_campaign_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_system_workspace_slug_global_uq"
  ON "brand_design_system" ("workspace_id", "slug")
  WHERE "campaign_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_system_workspace_slug_campaign_uq"
  ON "brand_design_system" ("workspace_id", "slug", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

--> statement-breakpoint

-- kb_collections: collection slug is per-workspace.
DROP INDEX IF EXISTS "kb_collections_slug_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "kb_collections_workspace_slug_uq"
  ON "kb_collections" ("workspace_id", "slug");
