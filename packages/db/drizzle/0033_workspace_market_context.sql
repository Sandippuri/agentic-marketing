-- Migration 0033: workspace market context (Place of the 4 Ps).
--
-- Structured fields the strategist needs so generated content stops being
-- geo-generic: which country/region the business sells into, which languages
-- to write in, which channels to prioritise. Freeform nuance (pricing story,
-- cultural notes, festival calendar, promotion mix) lives in a new
-- `market.context` row in `brand_memory` — added in code, not schema, because
-- brand_memory already accepts arbitrary slugs.
--
-- All columns are nullable. Empty workspaces fall back to the old behaviour
-- (no Market block injected) so nothing breaks for tenants that haven't
-- filled this in yet.

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "primary_country" text;

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "target_regions" text[];

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "languages" text[];

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "primary_channels" text[];
