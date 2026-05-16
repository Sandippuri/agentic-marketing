-- Migration 0032: per-post video-generation toggle.
--
-- Adds `needs_video` to content_items, mirroring `needs_images` (migration
-- 0010). When false, the submit-time hook and the workflow's
-- kickVideoVariantStep skip Veo entirely. When true (default), behaviour is
-- unchanged: the existing `contentTypeWantsVideo()` gate (linkedin / x_post /
-- x_thread only) still applies on top, so non-video types never produce a
-- clip regardless of the flag.
--
-- Toggling false -> true via PATCH /api/content/:id re-triggers a video kick
-- if no video asset exists yet, matching the needs_images pattern.

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "needs_video" boolean NOT NULL DEFAULT true;
