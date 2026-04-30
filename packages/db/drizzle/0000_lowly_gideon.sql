CREATE TYPE "public"."actor_kind" AS ENUM('human', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'changes_requested', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('poster', 'hero', 'og', 'email_header');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('draft', 'in_review', 'approved', 'published');--> statement-breakpoint
CREATE TYPE "public"."campaign_phase" AS ENUM('buildup', 'launch', 'post_launch');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('internal_blog', 'linkedin', 'x', 'email_hubspot', 'email_mailchimp');--> statement-breakpoint
CREATE TYPE "public"."content_stage" AS ENUM('pull', 'explain', 'reinforce', 'push');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'in_review', 'approved', 'scheduled', 'published', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('blog', 'linkedin', 'x_thread', 'x_post', 'email');--> statement-breakpoint
CREATE TYPE "public"."publish_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('content', 'campaign');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decision" "approval_decision",
	"decided_by" uuid,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"status" "asset_status" DEFAULT 'draft' NOT NULL,
	"storage_path" text NOT NULL,
	"template_id" text,
	"prompt_used" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_kind" "actor_kind" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"phase" "campaign_phase" DEFAULT 'buildup' NOT NULL,
	"owner_id" uuid,
	"start_date" date,
	"end_date" date,
	"brief_md" text,
	"calendar_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"type" "content_type" NOT NULL,
	"stage" "content_stage" DEFAULT 'explain' NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"channel_hints" jsonb,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_url" text,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"body_md" text NOT NULL,
	"change_note" text,
	"author_id" uuid,
	"author_kind" "actor_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" "scope_type" NOT NULL,
	"scope_id" uuid NOT NULL,
	"channel" "channel",
	"metric" text NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" "publish_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"external_url" text,
	"error" text,
	"thread_ref" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_content_idx" ON "approvals" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_content_idx" ON "assets" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_slug_uq" ON "campaigns" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_items_campaign_idx" ON "content_items" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_items_status_idx" ON "content_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_items_stage_idx" ON "content_items" USING btree ("stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_revisions_content_idx" ON "content_revisions" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metrics_scope_idx" ON "metrics" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metrics_metric_idx" ON "metrics" USING btree ("metric");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_content_idx" ON "publish_jobs" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_status_idx" ON "publish_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_channel_idx" ON "publish_jobs" USING btree ("channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_channel_created_idx" ON "publish_jobs" USING btree ("channel","created_at");