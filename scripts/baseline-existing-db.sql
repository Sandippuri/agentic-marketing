-- =============================================================================
-- One-time recovery for DBs that were set up via the OLD bootstrap.sql flow.
--
-- WHY THIS EXISTS
--   The old bootstrap.sql concatenated migrations 0000–0033 and applied them
--   in one paste, but it never recorded anything in _schema_migrations. After
--   we switched to a single source of truth (migrate.mjs), the runner has no
--   idea those 34 files already ran, and would try to re-apply them.
--
-- WHAT TO DO
--   1. Paste this entire file into the Supabase Dashboard SQL Editor and run
--      it once against your existing DB. (Safe — only writes one tracking row
--      per migration, with ON CONFLICT DO NOTHING.)
--   2. Then run:  pnpm db:migrate:run
--      …which will pick up 0034_chat_attachments.sql (and anything newer) as
--      the only pending migrations and apply them.
--
-- After this is done you never need this file again — delete it from your
-- checkout if you want, or leave it as a historical note. New databases set
-- up via scripts/setup-new-project.mjs do NOT need this; migrate.mjs records
-- everything as it runs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "_schema_migrations" (
  "filename"   text PRIMARY KEY,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  "applied_by" text        NOT NULL DEFAULT current_user
);

INSERT INTO _schema_migrations (filename) VALUES
  ('0000_lowly_gideon.sql'),
  ('0001_learning_loop.sql'),
  ('0002_generic_embeddings.sql'),
  ('0003_drop_content_embeddings.sql'),
  ('0004_brand_memory.sql'),
  ('0005_publish_job_mode.sql'),
  ('0006_brand_design_system.sql'),
  ('0007_generation_jobs.sql'),
  ('0008_campaign_scoped_brand.sql'),
  ('0009_workflow_runs.sql'),
  ('0010_content_needs_images.sql'),
  ('0011_video_assets.sql'),
  ('0012_llm_usage.sql'),
  ('0013_brand_documents.sql'),
  ('0014_llm_usage_workflow_run.sql'),
  ('0015_knowledge_base.sql'),
  ('0016_goal_loop.sql'),
  ('0017_variants.sql'),
  ('0018_experiments.sql'),
  ('0019_lifecycle.sql'),
  ('0020_brand_visual_language.sql'),
  ('0021_kb_fulltext.sql'),
  ('0022_visual_brief.sql'),
  ('0023_asset_judge_scores.sql'),
  ('0024_saas_foundation.sql'),
  ('0025_workspace_id_columns.sql'),
  ('0026_backfill_workspace.sql'),
  ('0027_workspace_id_not_null.sql'),
  ('0028_settings_per_workspace.sql'),
  ('0029_visual_direction_upstream.sql'),
  ('0030_researcher_step_name.sql'),
  ('0031_workspace_scoped_uniques.sql'),
  ('0032_content_needs_video.sql'),
  ('0033_workspace_market_context.sql')
ON CONFLICT (filename) DO NOTHING;

-- Verify — should show 34 rows (one per applied migration), and pnpm
-- db:migrate:list should then report 34 applied / 1+ pending.
SELECT count(*) AS recorded FROM _schema_migrations;
