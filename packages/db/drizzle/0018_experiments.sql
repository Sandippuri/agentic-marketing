-- Migration 0018: Experiments registry for A/B variant tracking.
--
-- One row per experiment. The Growth/Experiment sub-agent (Phase 3)
-- creates the row, then propose_winner reads outcomes and sets
-- winner_content_id when the configured threshold is hit.
--
-- threshold_json shape: { kind: "ctr_lift" | "cpm" | "engagement",
--                         min_sample_size: int, confidence: 0.0..1.0 }
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0018_experiments.sql

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'experiment_status') THEN
    CREATE TYPE "experiment_status" AS ENUM ('running', 'stopped', 'won', 'inconclusive');
  END IF;
END$$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "experiments" (
  "id"                 uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id"        uuid                     NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "variant_group"      uuid                     NOT NULL,
  "hypothesis"         text                     NOT NULL DEFAULT '',
  "metric"             text                     NOT NULL DEFAULT 'ctr',
  "threshold_json"     jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "status"             "experiment_status"      NOT NULL DEFAULT 'running',
  "winner_content_id"  uuid                     REFERENCES "content_items"("id") ON DELETE SET NULL,
  "sample_size"        integer                  NOT NULL DEFAULT 0,
  "started_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at"           timestamp with time zone,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "experiments_variant_group_uq"
  ON "experiments" ("variant_group");
CREATE INDEX IF NOT EXISTS "experiments_campaign_idx" ON "experiments" ("campaign_id");
CREATE INDEX IF NOT EXISTS "experiments_status_idx"   ON "experiments" ("status");

--> statement-breakpoint

-- Now that the experiments table exists, wire the FK from content_items.
-- (Column was added in 0017; we deferred the FK until the target existed.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'content_items' AND constraint_name = 'content_items_experiment_id_fk'
  ) THEN
    ALTER TABLE "content_items"
      ADD CONSTRAINT "content_items_experiment_id_fk"
      FOREIGN KEY ("experiment_id") REFERENCES "experiments"("id") ON DELETE SET NULL;
  END IF;
END$$;

--> statement-breakpoint

ALTER TABLE "experiments" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_read_experiments" ON "experiments";
CREATE POLICY "team_read_experiments" ON "experiments"
  FOR SELECT TO authenticated USING (true);
