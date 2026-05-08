-- Migration 0019: Lifecycle / CRM email sequences.
--
-- A sequence is an ordered list of content_items each backed by a
-- delay (delay_hours) from the previous step's publish-success event.
-- Goal-loop schedules step k+1 by inserting a publish_jobs row with
-- sequence_id + sequence_step_index when step k completes.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0019_lifecycle.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lifecycle_status') THEN
    CREATE TYPE "lifecycle_status" AS ENUM (
      'draft', 'active', 'paused', 'completed', 'archived'
    );
  END IF;
END$$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lifecycle_sequences" (
  "id"                uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id"       uuid                     NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "name"              text                     NOT NULL,
  "channel"           "channel"                NOT NULL,
  "audience_segment"  text,
  "status"            "lifecycle_status"       NOT NULL DEFAULT 'draft',
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "lifecycle_sequences_campaign_idx" ON "lifecycle_sequences" ("campaign_id");
CREATE INDEX IF NOT EXISTS "lifecycle_sequences_status_idx"   ON "lifecycle_sequences" ("status");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lifecycle_steps" (
  "id"             uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence_id"    uuid                     NOT NULL REFERENCES "lifecycle_sequences"("id") ON DELETE CASCADE,
  "step_index"     integer                  NOT NULL,
  "content_id"     uuid                     REFERENCES "content_items"("id") ON DELETE SET NULL,
  "delay_hours"    integer                  NOT NULL DEFAULT 0,
  "trigger_event"  text                     NOT NULL DEFAULT 'previous_published',
  "created_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "lifecycle_steps_sequence_index_uq"
  ON "lifecycle_steps" ("sequence_id", "step_index");
CREATE INDEX IF NOT EXISTS "lifecycle_steps_content_idx" ON "lifecycle_steps" ("content_id");

--> statement-breakpoint

ALTER TABLE "publish_jobs"
  ADD COLUMN IF NOT EXISTS "sequence_id"          uuid REFERENCES "lifecycle_sequences"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "sequence_step_index"  integer;

CREATE INDEX IF NOT EXISTS "publish_jobs_sequence_idx" ON "publish_jobs" ("sequence_id");

--> statement-breakpoint

ALTER TABLE "lifecycle_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lifecycle_steps"     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_read_lifecycle_sequences" ON "lifecycle_sequences";
CREATE POLICY "team_read_lifecycle_sequences" ON "lifecycle_sequences"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_read_lifecycle_steps" ON "lifecycle_steps";
CREATE POLICY "team_read_lifecycle_steps" ON "lifecycle_steps"
  FOR SELECT TO authenticated USING (true);
