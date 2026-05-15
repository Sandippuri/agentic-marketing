-- Migration 0028: convert `settings` to per-workspace + global fallback.
--
-- Layout after this migration:
--   * `workspace_id` uuid — NULL = global default row
--   * `key`          text  — setting name
--   * PK: (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'), key)
--     implemented as a unique index because Postgres PKs can't directly
--     contain a NULL-bearing column even with coalesce
--   * partial unique on (key) where workspace_id IS NULL — enforces "exactly
--     one global row per key" so the JS-level fallback merge is well-defined
--
-- Read pattern (handled in apps/web/app/api/settings/route.ts):
--   1. SELECT * FROM settings WHERE workspace_id = $ctx
--   2. SELECT * FROM settings WHERE workspace_id IS NULL AND key NOT IN (those from #1)
--   3. Merge — workspace value wins on conflict.
--
-- All existing rows are global (the table is single-tenant pre-PR 4), so the
-- backfill is: leave workspace_id NULL on everything. New workspace-scoped
-- entries arrive when a tenant overrides a global setting.
--
-- Idempotent.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0028_settings_per_workspace.sql

--> statement-breakpoint

-- 1. Add workspace_id column (nullable; global rows stay NULL).
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

DO $$ BEGIN
  ALTER TABLE "settings"
    ADD CONSTRAINT "settings_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

-- 2. Drop the old PK on (key) so two rows can share the same key as long as
--    they differ in workspace_id.
ALTER TABLE "settings" DROP CONSTRAINT IF EXISTS "settings_pkey";

--> statement-breakpoint

-- 3. Composite uniqueness on (coalesce(workspace_id, zero-uuid), key).
--    Using coalesce lets us treat a global row (NULL) and a workspace row
--    as distinct entries — and "at most one of each" — in a single index.
CREATE UNIQUE INDEX IF NOT EXISTS "settings_workspace_key_pk"
  ON "settings" (
    COALESCE("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "key"
  );

-- Lookup index (not unique) for the workspace-only read path.
CREATE INDEX IF NOT EXISTS "settings_workspace_key_idx"
  ON "settings" ("workspace_id", "key");

-- 4. Partial unique for the global fallback row (one per key). Defensive —
--    the coalesce index above already enforces this, but having a dedicated
--    constraint makes the intent obvious to anyone reading \d settings.
CREATE UNIQUE INDEX IF NOT EXISTS "settings_global_key_uq"
  ON "settings" ("key")
  WHERE "workspace_id" IS NULL;
