-- Migration 0011: promotional video assets.
--
-- Adds the `video_post` value to the asset_kind enum and two new columns on
-- `assets` to record the file's MIME type (so cards know whether to render
-- <img> vs <video>) and clip duration in seconds (Veo 3.1 returns 4–8s).
-- Both new columns are nullable so existing image rows are unaffected.

ALTER TYPE "asset_kind" ADD VALUE IF NOT EXISTS 'video_post';

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "mime_type" text;

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "duration_sec" integer;
