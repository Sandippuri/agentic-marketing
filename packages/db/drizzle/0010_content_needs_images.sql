-- Migration 0010: per-post image-generation toggle.
--
-- Adds `needs_images` to content_items so the human reviewer (or sub-agent)
-- can decide on a per-post basis whether the submit-for-review hook should
-- generate Replicate variants. Defaults to true to preserve existing
-- behaviour; the submit endpoint reads the flag and skips image generation
-- when false. Toggling the flag from false to true via PATCH /api/content/:id
-- re-triggers generation if no assets exist yet.

ALTER TABLE "content_items"
  ADD COLUMN IF NOT EXISTS "needs_images" boolean NOT NULL DEFAULT true;
