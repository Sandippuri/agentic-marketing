-- Migration 0012: per-call LLM usage + cost tracking.
--
-- One row per generateText / generateObject call across the orchestrator,
-- sub-agents, and workflows. Written by recordLlmUsage in @marketing/agents
-- and surfaced on the settings page (and any future cost dashboards).
--
-- cost_usd is computed at write time from the static price map in
-- @marketing/shared-types (LLM_PRICING) so historical rows remain correct
-- even if list prices change later. Null when the model id is not in the
-- price map.

CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "agent" text NOT NULL,
  "thread_ref" text,
  "job_id" uuid,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cached_input_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric(12, 6),
  "error" text
);

CREATE INDEX IF NOT EXISTS "llm_usage_occurred_at_idx"
  ON "llm_usage" ("occurred_at");
CREATE INDEX IF NOT EXISTS "llm_usage_model_idx"
  ON "llm_usage" ("model");
CREATE INDEX IF NOT EXISTS "llm_usage_agent_idx"
  ON "llm_usage" ("agent");
