-- Migration 0004: brand_memory table + its RLS.
-- Stores the five brand/product documents that used to live as Markdown files
-- in apps/manager/memory/{brand,product}/*.md so non-engineers can edit voice
-- / ICP / positioning / visual / product state from the admin UI.
--
-- Going forward, RLS for new tables ships INSIDE the migration (idempotent
-- via DROP POLICY IF EXISTS) instead of being added to infra/supabase/policies.sql.
-- That way an upgrade only ever needs to apply migrations.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0004_brand_memory.sql

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brand_memory" (
  "id"         uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"       text                     NOT NULL,
  "title"      text                     NOT NULL,
  "body"       text                     NOT NULL DEFAULT '',
  "updated_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "brand_memory_slug_uq" UNIQUE ("slug")
);

--> statement-breakpoint

ALTER TABLE "brand_memory" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

-- Authenticated team members can read. Writes happen via the service role
-- (the admin UI's PUT route) — no team_write policy on purpose.
DROP POLICY IF EXISTS "team_read_brand_memory" ON "brand_memory";
CREATE POLICY "team_read_brand_memory" ON "brand_memory"
  FOR SELECT TO authenticated USING (true);
