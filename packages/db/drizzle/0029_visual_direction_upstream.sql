-- Migration 0029: move visual direction upstream from the Art Director.
--
-- visual_identity (campaigns): the Strategist now sets a campaign-level
-- visual identity (recurring motifs, color/mood, art style, banned aesthetics)
-- alongside the calendar. Reused across every post in the campaign.
--
-- image_brief (content_items): the Content agent now emits a per-post image
-- brief (subject, composition, mood, overlay text, must-show / must-not-show)
-- alongside the body copy. The Art Director becomes a refiner that translates
-- imageBrief + visual_identity into a single optimized prompt — instead of
-- guessing the visual from the body alone.
--
-- Both columns are nullable jsonb so existing campaigns and content rows keep
-- working; the Art Director falls back to body-only inference when missing.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0029_visual_direction_upstream.sql

--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "visual_identity" jsonb;

--> statement-breakpoint

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "image_brief" jsonb;
