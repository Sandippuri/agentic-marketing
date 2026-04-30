-- Phase 11: Learning Loop
-- Requires pgvector extension (enable once per Supabase project).
CREATE EXTENSION IF NOT EXISTS vector;

--> statement-breakpoint

-- agent_feedback: captures every approval decision for future fine-tuning
CREATE TABLE IF NOT EXISTS "agent_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_id" uuid NOT NULL REFERENCES "content_items"("id") ON DELETE CASCADE,
  "revision_id" uuid,
  "ai_draft_md" text NOT NULL,
  "human_final_md" text,
  "decision" "approval_decision" NOT NULL,
  "edit_distance" integer,
  "decided_by" uuid,
  "decided_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reason" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_feedback_content_idx" ON "agent_feedback" ("content_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_feedback_decision_idx" ON "agent_feedback" ("decision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_feedback_decided_at_idx" ON "agent_feedback" ("decided_at");

--> statement-breakpoint

-- outcomes: rolled-up performance metrics per content × channel × window
CREATE TABLE IF NOT EXISTS "outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_id" uuid NOT NULL REFERENCES "content_items"("id") ON DELETE CASCADE,
  "channel" "channel" NOT NULL,
  "window" text NOT NULL,
  "impressions" integer NOT NULL DEFAULT 0,
  "clicks" integer NOT NULL DEFAULT 0,
  "ctr" numeric(10, 6) NOT NULL DEFAULT 0,
  "conversions" integer NOT NULL DEFAULT 0,
  "engagement_rate" numeric(10, 6) NOT NULL DEFAULT 0,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outcomes_content_channel_window_uq"
  ON "outcomes" ("content_id", "channel", "window");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcomes_ctr_idx" ON "outcomes" ("ctr");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcomes_channel_idx" ON "outcomes" ("channel");

--> statement-breakpoint

-- content_embeddings: text-embedding-3-small vectors for semantic retrieval
CREATE TABLE IF NOT EXISTS "content_embeddings" (
  "content_id" uuid PRIMARY KEY REFERENCES "content_items"("id") ON DELETE CASCADE,
  "embedding" vector(1536) NOT NULL,
  "embedded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "model" text NOT NULL DEFAULT 'text-embedding-3-small'
);
--> statement-breakpoint
-- ivfflat index for cosine similarity search (tune lists= for your dataset size)
CREATE INDEX IF NOT EXISTS "content_embeddings_ivfflat_idx"
  ON "content_embeddings" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
