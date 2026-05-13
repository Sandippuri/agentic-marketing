-- Migration 0022: persist the Art Director's visual concept brief on the
-- content_items row so multiple modalities (image, video, future carousels)
-- consume one source of truth instead of re-deriving creative direction.
--
-- visual_brief is free-form jsonb (the brief shape evolves) but at least
-- always contains: concept_summary, composition, focal_point, real_subjects,
-- reference_image_urls, style_notes, banned_elements, and optional motion.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0022_visual_brief.sql

--> statement-breakpoint

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "visual_brief" jsonb;
