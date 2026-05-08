-- Migration 0020: Extend brand_design_system with visual_language.
--
-- Today brand_design_system stores colors / typography / logos / tokens
-- (the "what to use"). The asset agent picks up the right palette but
-- still produces generic stock-AI imagery because there's no field for
-- the "how to compose, what NOT to look like".
--
-- visual_language jsonb shape (free-form, evolves with brand):
--   {
--     signature_compositions: string[]
--     banned_aesthetics: string[]            // negative-prompt seeds
--     motion_language: string                // for video assets
--     typography_in_image: { rules: string[] }
--     mood_keywords: string[]
--     lighting: string
--     subjects_to_prefer: string[]
--     subjects_to_avoid: string[]
--   }
--
-- Read by the new Art Director sub-agent (Phase 2.5) before any image
-- generation step.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0020_brand_visual_language.sql

--> statement-breakpoint

ALTER TABLE "brand_design_system"
  ADD COLUMN IF NOT EXISTS "visual_language" jsonb NOT NULL DEFAULT '{}'::jsonb;
