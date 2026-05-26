-- Migration 0040: multi-image per post.
--
-- A post may need 2–4 images (carousel, album, multi-image tweet). Until now
-- the pipeline was hard-locked to one image per content_item. This migration
-- enables N images by:
--
-- 1. Reshaping content_items.image_brief from a single object to an ARRAY of
--    image briefs. The Content agent will emit 1–4 briefs depending on what
--    the post needs (clamped to the channel's native max — 1 for LinkedIn,
--    4 for IG/FB/X). Column name stays `image_brief`; only the JSON shape
--    changes. Non-null existing rows are wrapped into a single-element array.
--
-- 2. Adding assets.sequence_order — which slot (0…N-1) this asset belongs to.
--    The asset pipeline writes one approved asset per slot (plus draft
--    variants/rejected candidates tagged to the same slot). Existing rows
--    default to slot 0, which is correct for legacy single-image posts.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0040_multi_image_per_post.sql

--> statement-breakpoint

-- Backfill: wrap any non-null single-object image_brief into a one-element
-- array. Skip rows where it's already an array (idempotent re-run).
UPDATE "content_items"
SET "image_brief" = jsonb_build_array("image_brief")
WHERE "image_brief" IS NOT NULL
  AND jsonb_typeof("image_brief") = 'object';

--> statement-breakpoint

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "sequence_order" integer NOT NULL DEFAULT 0;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "assets_content_sequence_idx"
  ON "assets" ("content_id", "sequence_order");
