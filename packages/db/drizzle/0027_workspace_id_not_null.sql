-- Migration 0027: flip workspace_id to NOT NULL on every tenant table.
--
-- DO NOT APPLY THIS UNTIL PR 5 HAS LANDED. The application code only starts
-- setting workspace_id on every INSERT once PR 5 (entitlement + metering)
-- plumbs context through the orchestrator, workflows, and the agents
-- package. Applying 0027 before then would cause every llm_usage /
-- workflow_run / generation_job insert to fail in production.
--
-- Apply order during PR 5 rollout:
--   1. Deploy PR 5 (workspace_id is now passed everywhere; the Drizzle
--      column type is flipped to .notNull() in the same PR).
--   2. Apply this migration 0027.
--   3. Run the smoke test: a chat turn should produce an llm_usage row
--      with a non-null workspace_id.
--
-- Run AFTER 0026_backfill_workspace.sql. If any row is still null at this
-- point the ALTER aborts — that's the desired safety net.
--
-- audit_log and billing_events stay nullable because their workspace FK is
-- ON DELETE SET NULL (audit trail and webhook ledger must survive workspace
-- deletion).
--
-- Also re-scopes slug uniqueness on:
--   - campaigns.slug          → unique within (workspace_id, slug)
--   - kb_collections.slug     → unique within (workspace_id, slug)
-- so two tenants can each own a "summer-launch" campaign or "brand"
-- collection without colliding.
--
-- settings.key stays as a global PK in this migration; PR 4 converts it
-- to (workspace_id, key) with a partial unique on global rows.
--
-- Idempotent: ALTER COLUMN SET NOT NULL is a no-op when already set, and
-- CREATE INDEX uses IF NOT EXISTS / DROP INDEX uses IF EXISTS.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0027_workspace_id_not_null.sql

--> statement-breakpoint

ALTER TABLE "campaigns"            ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "content_items"        ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "content_revisions"    ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "approvals"            ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "publish_jobs"         ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "assets"               ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "metrics"              ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "agent_feedback"       ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "outcomes"             ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "embeddings"           ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "brand_memory"         ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "brand_design_system"  ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "brand_documents"      ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "extraction_runs"      ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "brand_memory_drafts"  ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "generation_jobs"      ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "workflow_runs"        ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "llm_usage"            ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "kb_collections"       ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "kb_documents"         ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "kb_chunks"            ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "goal_events"          ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "experiments"          ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "lifecycle_sequences"  ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "lifecycle_steps"      ALTER COLUMN "workspace_id" SET NOT NULL;

--> statement-breakpoint

-- Re-scope slug uniqueness to (workspace_id, slug).
-- Both indexes were originally created on the slug alone (see migration 0001
-- for campaigns and 0015 for kb_collections). The replacement happens in
-- two steps so an in-flight INSERT during the swap can't see *zero*
-- protective indexes — we create the new one first, then drop the old.

CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_workspace_slug_uq"
  ON "campaigns" ("workspace_id", "slug");
DROP INDEX IF EXISTS "campaigns_slug_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "kb_collections_workspace_slug_uq"
  ON "kb_collections" ("workspace_id", "slug");
DROP INDEX IF EXISTS "kb_collections_slug_uq";
