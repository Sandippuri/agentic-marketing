-- Migration 0016: Goal-driven autonomous campaigns.
--
-- Extends `campaigns` with the fields a long-running goal loop needs to
-- plan → fan out → wait on approvals → publish → measure → re-evaluate
-- with budget/deadline guard rails and resume-on-crash semantics.
--
-- New `goal_events` table is the durable trail the goal-loop workflow
-- reads on resume. Combined with Vercel Workflows' native durable
-- execution, the loop can be killed and restarted safely.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0016_goal_loop.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loop_status') THEN
    CREATE TYPE "loop_status" AS ENUM (
      'idle', 'planning', 'executing', 'awaiting_approval',
      'measuring', 'converged', 'failed', 'halted'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'goal_event_kind') THEN
    CREATE TYPE "goal_event_kind" AS ENUM (
      'plan_drafted', 'fanout_started', 'approval_requested',
      'approval_resolved', 'published', 'outcome_observed',
      'reevaluated', 'converged', 'halted', 'error'
    );
  END IF;
END$$;

--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "goal_definition"   jsonb,
  ADD COLUMN IF NOT EXISTS "target_metrics"    jsonb,
  ADD COLUMN IF NOT EXISTS "loop_status"       "loop_status" NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS "loop_iteration"    integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "budget_cents"      integer,
  ADD COLUMN IF NOT EXISTS "cost_cents_spent"  integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deadline"          timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_iteration_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "parent_goal_id"    uuid;

CREATE INDEX IF NOT EXISTS "campaigns_loop_status_idx" ON "campaigns" ("loop_status");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "goal_events" (
  "id"           uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id"  uuid                     NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "iteration"    integer                  NOT NULL DEFAULT 0,
  "kind"         "goal_event_kind"        NOT NULL,
  "step_key"     text,
  "payload"      jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "ts"           timestamp with time zone NOT NULL DEFAULT now()
);

-- Idempotency key: (campaign_id, iteration, step_key) when step_key set.
-- Used by the loop's step.do() wrappers to skip work that already happened.
CREATE UNIQUE INDEX IF NOT EXISTS "goal_events_idempotency_uq"
  ON "goal_events" ("campaign_id", "iteration", "step_key")
  WHERE "step_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "goal_events_campaign_idx"  ON "goal_events" ("campaign_id");
CREATE INDEX IF NOT EXISTS "goal_events_kind_idx"      ON "goal_events" ("kind");
CREATE INDEX IF NOT EXISTS "goal_events_ts_idx"        ON "goal_events" ("ts");

--> statement-breakpoint

ALTER TABLE "goal_events" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_read_goal_events" ON "goal_events";
CREATE POLICY "team_read_goal_events" ON "goal_events"
  FOR SELECT TO authenticated USING (true);
