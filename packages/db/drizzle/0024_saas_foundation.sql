-- Migration 0024: SaaS foundation.
-- Adds the workspace / billing / metering tables. Does NOT touch existing
-- tenant tables (those get their nullable `workspace_id` column in 0025) and
-- does NOT enforce anything in the running app — PR 1's goal is "schema
-- exists, app behaves identically."
--
-- Idempotency: every CREATE uses IF NOT EXISTS and every plan seed uses
-- INSERT … ON CONFLICT DO UPDATE so this file can be applied multiple times
-- against the same database.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0024_saas_foundation.sql

--> statement-breakpoint

-- --- enums --------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "plan_code" AS ENUM ('free','starter','growth','business','enterprise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "subscription_status" AS ENUM ('trialing','active','past_due','grace','canceled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "billing_provider" AS ENUM ('khalti','stripe','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "billing_period" AS ENUM ('monthly','yearly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "workspace_role" AS ENUM ('owner','admin','editor','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "admin_role" AS ENUM ('superadmin','support');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --- workspaces ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"                    text NOT NULL,
  "name"                    text NOT NULL,
  "owner_user_id"           uuid NOT NULL,
  "plan_id"                 uuid NOT NULL,
  "plan_overridden_until"   timestamptz,
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  "updated_at"              timestamptz NOT NULL DEFAULT now(),
  "deleted_at"              timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_slug_uq"  ON "workspaces" ("slug");
CREATE INDEX        IF NOT EXISTS "workspaces_owner_idx" ON "workspaces" ("owner_user_id");
CREATE INDEX        IF NOT EXISTS "workspaces_plan_idx"  ON "workspaces" ("plan_id");

-- --- plans --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "plans" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"                     plan_code NOT NULL,
  "name"                     text NOT NULL,
  "description"              text NOT NULL DEFAULT '',
  "price_monthly_npr"        integer NOT NULL DEFAULT 0,
  "price_yearly_npr"         integer NOT NULL DEFAULT 0,
  "price_monthly_usd_cents"  integer,
  "price_yearly_usd_cents"   integer,
  "features"                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  "quotas"                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_public"                boolean NOT NULL DEFAULT true,
  "sort_order"               integer NOT NULL DEFAULT 0,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "plans_code_uq"        ON "plans" ("code");
CREATE INDEX        IF NOT EXISTS "plans_public_sort_idx" ON "plans" ("is_public", "sort_order");

-- workspaces.plan_id FK can't be added until plans exists — do it now.
DO $$ BEGIN
  ALTER TABLE "workspaces"
    ADD CONSTRAINT "workspaces_plan_id_fk"
      FOREIGN KEY ("plan_id") REFERENCES "plans"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --- workspace_members --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"   uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id"        uuid,
  "role"           workspace_role NOT NULL,
  "invited_email"  text,
  "invited_token"  text,
  "invited_at"     timestamptz,
  "accepted_at"    timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

-- Partial: only accepted memberships are unique by (workspace, user); pending
-- invites (user_id null) are not deduped here.
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspace_user_uq"
  ON "workspace_members" ("workspace_id", "user_id")
  WHERE "user_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_invited_token_uq"
  ON "workspace_members" ("invited_token")
  WHERE "invited_token" IS NOT NULL;

-- --- subscriptions ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"              uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "plan_id"                   uuid NOT NULL REFERENCES "plans"("id"),
  "status"                    subscription_status NOT NULL,
  "provider"                  billing_provider NOT NULL,
  "provider_subscription_id"  text,
  "provider_customer_id"      text,
  "billing_period"            billing_period NOT NULL DEFAULT 'monthly',
  "current_period_start"      timestamptz NOT NULL,
  "current_period_end"        timestamptz NOT NULL,
  "cancel_at_period_end"      boolean NOT NULL DEFAULT false,
  "trial_end"                 timestamptz,
  "canceled_at"               timestamptz,
  "metadata"                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "subscriptions_workspace_idx"    ON "subscriptions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "subscriptions_provider_sub_idx" ON "subscriptions" ("provider_subscription_id");
CREATE INDEX IF NOT EXISTS "subscriptions_status_expiry_idx" ON "subscriptions" ("status", "current_period_end");

-- One *live* subscription per workspace. Old canceled / expired rows stay.
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_one_live_per_workspace_uq"
  ON "subscriptions" ("workspace_id")
  WHERE "status" IN ('trialing','active','past_due','grace');

-- --- billing_events -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "billing_events" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"          uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "subscription_id"       uuid REFERENCES "subscriptions"("id") ON DELETE SET NULL,
  "provider"              billing_provider NOT NULL,
  "event_type"            text NOT NULL,
  "provider_event_id"     text NOT NULL,
  "payload"               jsonb NOT NULL,
  "signature"             text,
  "received_at"           timestamptz NOT NULL DEFAULT now(),
  "processed_at"          timestamptz,
  "processing_error"      text
);

-- Idempotency key for webhook replays.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_events_provider_event_uq"
  ON "billing_events" ("provider", "provider_event_id");

CREATE INDEX IF NOT EXISTS "billing_events_workspace_received_idx"
  ON "billing_events" ("workspace_id", "received_at");

CREATE INDEX IF NOT EXISTS "billing_events_type_idx" ON "billing_events" ("event_type");

-- --- usage_events -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "usage_events" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"   uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "metric"         text NOT NULL,
  "delta"          bigint NOT NULL,
  "subject_type"   text,
  "subject_id"     text,
  "blocked"        boolean NOT NULL DEFAULT false,
  "metadata"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "usage_events_workspace_occurred_idx"
  ON "usage_events" ("workspace_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "usage_events_metric_occurred_idx"
  ON "usage_events" ("metric", "occurred_at");

CREATE INDEX IF NOT EXISTS "usage_events_subject_idx"
  ON "usage_events" ("subject_type", "subject_id");

-- --- usage_counters -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "usage_counters" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"   uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "period_start"   date NOT NULL,
  "period_end"     date NOT NULL,
  "metric"         text NOT NULL,
  "value"          bigint NOT NULL DEFAULT 0,
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "usage_counters_workspace_period_metric_uq"
  ON "usage_counters" ("workspace_id", "period_start", "metric");

CREATE INDEX IF NOT EXISTS "usage_counters_metric_period_idx"
  ON "usage_counters" ("workspace_id", "metric", "period_start");

-- --- admin_users --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "admin_users" (
  "user_id"      uuid PRIMARY KEY,
  "role"         admin_role NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

-- --- seed plans ---------------------------------------------------------------
-- Stable UUIDs from @marketing/shared-types/billing PLAN_IDS so this seed
-- stays idempotent and code can look plans up by either id or code.
-- ON CONFLICT DO UPDATE so re-applying the migration syncs price/feature
-- changes the catalog made during development.

INSERT INTO "plans" (
  "id","code","name","description",
  "price_monthly_npr","price_yearly_npr",
  "price_monthly_usd_cents","price_yearly_usd_cents",
  "features","quotas","is_public","sort_order"
) VALUES
(
  '11111111-1111-1111-1111-000000000001','free','Free',
  'Evaluate the product. Watermarked outputs, single user.',
  0, 0, 0, 0,
  '{"asset_pipeline":false,"video_assets":false,"web_research":false,"goal_loop":false,"experiments":false,"lifecycle_sequences":false,"custom_kb_collections":false,"api_access":false,"priority_queue":false,"multi_seat":false}'::jsonb,
  '{"seats":1,"orchestrator_messages":50,"sub_agent_calls":100,"single_post_runs":10,"asset_pipeline_runs":0,"kb_embeds":50,"kb_docs":5,"kb_doc_bytes":10485760,"published_posts":5,"llm_input_tokens":200000,"llm_output_tokens":50000,"llm_cost_usd_micros":1000000}'::jsonb,
  true, 0
),
(
  '11111111-1111-1111-1111-000000000002','starter','Starter',
  'Solo marketers and freelancers.',
  2499, 24990, 2900, 29000,
  '{"asset_pipeline":false,"video_assets":false,"web_research":false,"goal_loop":false,"experiments":false,"lifecycle_sequences":false,"custom_kb_collections":false,"api_access":false,"priority_queue":false,"multi_seat":true}'::jsonb,
  '{"seats":2,"orchestrator_messages":500,"sub_agent_calls":1500,"single_post_runs":100,"asset_pipeline_runs":0,"kb_embeds":500,"kb_docs":50,"kb_doc_bytes":104857600,"published_posts":60,"llm_input_tokens":2000000,"llm_output_tokens":500000,"llm_cost_usd_micros":20000000}'::jsonb,
  true, 1
),
(
  '11111111-1111-1111-1111-000000000003','growth','Growth',
  'SMBs and small agencies. Asset pipeline + research.',
  7999, 79990, 8900, 89000,
  '{"asset_pipeline":true,"video_assets":false,"web_research":true,"goal_loop":true,"experiments":true,"lifecycle_sequences":false,"custom_kb_collections":false,"api_access":false,"priority_queue":false,"multi_seat":true}'::jsonb,
  '{"seats":5,"orchestrator_messages":3000,"sub_agent_calls":10000,"single_post_runs":500,"asset_pipeline_runs":200,"kb_embeds":5000,"kb_docs":500,"kb_doc_bytes":1073741824,"published_posts":300,"llm_input_tokens":15000000,"llm_output_tokens":3000000,"llm_cost_usd_micros":80000000}'::jsonb,
  true, 2
),
(
  '11111111-1111-1111-1111-000000000004','business','Business',
  'Agencies and mid-market. Multi-brand, video, API, lifecycle.',
  24999, 249990, 24900, 249000,
  '{"asset_pipeline":true,"video_assets":true,"web_research":true,"goal_loop":true,"experiments":true,"lifecycle_sequences":true,"custom_kb_collections":true,"api_access":true,"priority_queue":true,"multi_seat":true}'::jsonb,
  '{"seats":15,"orchestrator_messages":15000,"sub_agent_calls":50000,"single_post_runs":2500,"asset_pipeline_runs":1000,"kb_embeds":50000,"kb_docs":5000,"kb_doc_bytes":10737418240,"published_posts":1500,"llm_input_tokens":75000000,"llm_output_tokens":15000000,"llm_cost_usd_micros":250000000}'::jsonb,
  true, 3
),
(
  '11111111-1111-1111-1111-000000000005','enterprise','Enterprise',
  'Custom limits, SSO, dedicated infra, SLAs. Talk to sales.',
  75000, 750000, 75000, 750000,
  '{"asset_pipeline":true,"video_assets":true,"web_research":true,"goal_loop":true,"experiments":true,"lifecycle_sequences":true,"custom_kb_collections":true,"api_access":true,"priority_queue":true,"multi_seat":true}'::jsonb,
  '{"seats":50,"orchestrator_messages":-1,"sub_agent_calls":-1,"single_post_runs":-1,"asset_pipeline_runs":-1,"kb_embeds":-1,"kb_docs":-1,"kb_doc_bytes":-1,"published_posts":-1,"llm_input_tokens":-1,"llm_output_tokens":-1,"llm_cost_usd_micros":-1}'::jsonb,
  false, 4
)
ON CONFLICT ("id") DO UPDATE SET
  "name"                    = EXCLUDED.name,
  "description"             = EXCLUDED.description,
  "price_monthly_npr"       = EXCLUDED.price_monthly_npr,
  "price_yearly_npr"        = EXCLUDED.price_yearly_npr,
  "price_monthly_usd_cents" = EXCLUDED.price_monthly_usd_cents,
  "price_yearly_usd_cents"  = EXCLUDED.price_yearly_usd_cents,
  "features"                = EXCLUDED.features,
  "quotas"                  = EXCLUDED.quotas,
  "is_public"               = EXCLUDED.is_public,
  "sort_order"              = EXCLUDED.sort_order,
  "updated_at"              = now();
