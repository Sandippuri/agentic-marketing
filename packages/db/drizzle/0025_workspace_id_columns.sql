-- Migration 0025: add nullable workspace_id to every tenant-bearing table.
--
-- These columns stay nullable through PR 1–2 so the migration is non-breaking.
-- PR 3 (migration 0026) backfills them from the Legacy workspace, then
-- PR 3 (migration 0027) flips them NOT NULL. Don't add app-level enforcement
-- against these columns yet; the entire surface still treats the data as
-- single-tenant.
--
-- Excluded tables (deliberately):
--   - generation_job_steps : inherits via generation_jobs.workspace_id
--   - settings             : converted to (workspace_id, key) PK in PR 4
--   - billing_events,
--     workspaces, plans,
--     workspace_members,
--     subscriptions,
--     usage_events/counters,
--     admin_users          : SaaS tables added in 0024; already tenant-aware
--
-- Idempotent: every ALTER uses IF NOT EXISTS for the column, and every CREATE
-- INDEX uses IF NOT EXISTS for the index.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0025_workspace_id_columns.sql

--> statement-breakpoint

-- campaigns
ALTER TABLE "campaigns"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "campaigns_workspace_idx" ON "campaigns" ("workspace_id");

-- content_items
ALTER TABLE "content_items"      ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "content_items" ADD CONSTRAINT "content_items_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "content_items_workspace_idx" ON "content_items" ("workspace_id");

-- content_revisions
ALTER TABLE "content_revisions"  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "content_revisions_workspace_idx" ON "content_revisions" ("workspace_id");

-- approvals
ALTER TABLE "approvals"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "approvals_workspace_idx" ON "approvals" ("workspace_id");

-- publish_jobs
ALTER TABLE "publish_jobs"       ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "publish_jobs_workspace_idx" ON "publish_jobs" ("workspace_id");

-- assets
ALTER TABLE "assets"             ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "assets_workspace_idx" ON "assets" ("workspace_id");

-- metrics
ALTER TABLE "metrics"            ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "metrics" ADD CONSTRAINT "metrics_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "metrics_workspace_idx" ON "metrics" ("workspace_id");

-- audit_log (set null on delete so audit trail outlives the workspace)
ALTER TABLE "audit_log"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "audit_log_workspace_idx" ON "audit_log" ("workspace_id", "at");

-- agent_feedback
ALTER TABLE "agent_feedback"     ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "agent_feedback_workspace_idx" ON "agent_feedback" ("workspace_id");

-- outcomes
ALTER TABLE "outcomes"           ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "outcomes_workspace_idx" ON "outcomes" ("workspace_id");

-- embeddings (security-critical; see PR 9 for dedicated role + RLS)
ALTER TABLE "embeddings"         ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "embeddings_workspace_idx" ON "embeddings" ("workspace_id");

-- brand_memory
ALTER TABLE "brand_memory"       ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "brand_memory" ADD CONSTRAINT "brand_memory_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "brand_memory_workspace_idx" ON "brand_memory" ("workspace_id");

-- brand_design_system
ALTER TABLE "brand_design_system" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "brand_design_system" ADD CONSTRAINT "brand_design_system_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "brand_design_system_workspace_idx" ON "brand_design_system" ("workspace_id");

-- brand_documents
ALTER TABLE "brand_documents"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "brand_documents" ADD CONSTRAINT "brand_documents_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "brand_documents_workspace_idx" ON "brand_documents" ("workspace_id");

-- extraction_runs
ALTER TABLE "extraction_runs"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "extraction_runs_workspace_idx" ON "extraction_runs" ("workspace_id");

-- brand_memory_drafts
ALTER TABLE "brand_memory_drafts" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "brand_memory_drafts" ADD CONSTRAINT "brand_memory_drafts_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "brand_memory_drafts_workspace_idx" ON "brand_memory_drafts" ("workspace_id");

-- generation_jobs
ALTER TABLE "generation_jobs"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "generation_jobs_workspace_idx" ON "generation_jobs" ("workspace_id");

-- workflow_runs
ALTER TABLE "workflow_runs"      ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "workflow_runs_workspace_idx" ON "workflow_runs" ("workspace_id");

-- llm_usage
ALTER TABLE "llm_usage"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "llm_usage_workspace_idx" ON "llm_usage" ("workspace_id", "occurred_at");

-- kb_collections
ALTER TABLE "kb_collections"     ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "kb_collections" ADD CONSTRAINT "kb_collections_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "kb_collections_workspace_idx" ON "kb_collections" ("workspace_id");

-- kb_documents
ALTER TABLE "kb_documents"       ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "kb_documents_workspace_idx" ON "kb_documents" ("workspace_id");

-- kb_chunks
ALTER TABLE "kb_chunks"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "kb_chunks_workspace_idx" ON "kb_chunks" ("workspace_id");

-- goal_events
ALTER TABLE "goal_events"        ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "goal_events" ADD CONSTRAINT "goal_events_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "goal_events_workspace_idx" ON "goal_events" ("workspace_id");

-- experiments
ALTER TABLE "experiments"        ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "experiments" ADD CONSTRAINT "experiments_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "experiments_workspace_idx" ON "experiments" ("workspace_id");

-- lifecycle_sequences
ALTER TABLE "lifecycle_sequences" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "lifecycle_sequences" ADD CONSTRAINT "lifecycle_sequences_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "lifecycle_sequences_workspace_idx" ON "lifecycle_sequences" ("workspace_id");

-- lifecycle_steps
ALTER TABLE "lifecycle_steps"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
DO $$ BEGIN ALTER TABLE "lifecycle_steps" ADD CONSTRAINT "lifecycle_steps_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "lifecycle_steps_workspace_idx" ON "lifecycle_steps" ("workspace_id");
