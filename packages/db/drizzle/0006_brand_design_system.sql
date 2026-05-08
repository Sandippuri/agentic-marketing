-- Migration 0006: brand_design_system table + RLS.
-- Stores the structured design tokens (color palette, typography, logo
-- references, spacing/radii notes) that the asset sub-agent and human
-- operators consult when producing branded creative. Logos are stored as
-- file paths in the existing `assets` Supabase Storage bucket; everything
-- else is JSONB.
--
-- One row per slug. Today only 'default' is used; the slug column is
-- there so we can host multiple brands in the same install later without
-- another migration.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0006_brand_design_system.sql

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brand_design_system" (
  "id"         uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"       text                     NOT NULL DEFAULT 'default',
  "colors"     jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "typography" jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "logos"      jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "tokens"     jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "updated_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "brand_design_system_slug_uq" UNIQUE ("slug")
);

--> statement-breakpoint

ALTER TABLE "brand_design_system" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

-- Same pattern as brand_memory: authenticated team members read; writes go
-- through the service role on the admin PUT route.
DROP POLICY IF EXISTS "team_read_brand_design_system" ON "brand_design_system";
CREATE POLICY "team_read_brand_design_system" ON "brand_design_system"
  FOR SELECT TO authenticated USING (true);
