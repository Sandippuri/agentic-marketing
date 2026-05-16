import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  bigint,
  date,
  boolean,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

// pgvector column type (requires the `vector` extension on Postgres).
// Drizzle doesn't have first-class pgvector support yet, so we use customType.
const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() { return `vector(${dimensions})`; },
    fromDriver(val: string) {
      // pgvector returns e.g. "[0.1,0.2,...]"
      return JSON.parse(val.replace(/^\[/, "[").replace(/\]$/, "]"));
    },
    toDriver(val: number[]) { return `[${val.join(",")}]`; },
  })(name);
import {
  CAMPAIGN_PHASES,
  CAMPAIGN_STATUSES,
  CONTENT_TYPES,
  CONTENT_STAGES,
  CONTENT_STATUSES,
  APPROVAL_DECISIONS,
  PUBLISH_JOB_STATUSES,
  ASSET_KINDS,
  ASSET_STATUSES,
  ACTOR_KINDS,
  SCOPE_TYPES,
  CHANNELS,
  BRAND_DOC_STATUSES,
  BRAND_DRAFT_STATUSES,
  EXTRACTION_RUN_STATUSES,
  PLAN_CODES,
  SUBSCRIPTION_STATUSES,
  BILLING_PROVIDERS,
  BILLING_PERIODS,
  WORKSPACE_ROLES,
  ADMIN_ROLES,
} from "@marketing/shared-types";
import type {
  DesignColor,
  DesignTypography,
  DesignLogo,
  DesignTokens,
  BrandDraftCitation,
} from "@marketing/shared-types";

// `owner_id`, `decided_by`, and other actor columns are uuids that reference
// Supabase's `auth.users(id)`. We do NOT declare a Drizzle FK to that table:
// the migration role can't write to the `auth` schema on a managed Supabase
// project, and Supabase already enforces auth.users(id) as a uuid PK.

// --- Enums --------------------------------------------------------------------

export const campaignPhaseEnum = pgEnum("campaign_phase", CAMPAIGN_PHASES);
export const campaignStatusEnum = pgEnum("campaign_status", CAMPAIGN_STATUSES);
export const contentTypeEnum = pgEnum("content_type", CONTENT_TYPES);
export const contentStageEnum = pgEnum("content_stage", CONTENT_STAGES);
export const contentStatusEnum = pgEnum("content_status", CONTENT_STATUSES);
export const approvalDecisionEnum = pgEnum(
  "approval_decision",
  APPROVAL_DECISIONS,
);
export const publishJobStatusEnum = pgEnum(
  "publish_job_status",
  PUBLISH_JOB_STATUSES,
);
export const publishJobModeEnum = pgEnum("publish_job_mode", ["live", "test"]);
export const assetKindEnum = pgEnum("asset_kind", ASSET_KINDS);
export const assetStatusEnum = pgEnum("asset_status", ASSET_STATUSES);
export const actorKindEnum = pgEnum("actor_kind", ACTOR_KINDS);
export const scopeTypeEnum = pgEnum("scope_type", SCOPE_TYPES);
export const channelEnum = pgEnum("channel", CHANNELS);
export const embeddingSourceTypeEnum = pgEnum("embedding_source_type", [
  "content",
  "brand_doc",
  "rejected_draft",
  "kb_chunk",
] as const);
export const kbCollectionKindEnum = pgEnum("kb_collection_kind", [
  "brand",
  "product",
  "persona",
  "competitor",
  "sop",
  "playbook",
  "past_content",
  "asset_caption",
  "visual_reference",
  "external_doc",
] as const);
export const kbScopeEnum = pgEnum("kb_scope", ["global", "campaign"] as const);
export const kbDocSourceEnum = pgEnum("kb_doc_source", [
  "manual",
  "extracted",
  "agent",
  "channel_sop",
  "ga4",
  "web",
  "upload",
] as const);
export const kbDocStatusEnum = pgEnum("kb_doc_status", [
  "draft",
  "active",
  "archived",
  "superseded",
] as const);
export const loopStatusEnum = pgEnum("loop_status", [
  "idle",
  "planning",
  "executing",
  "awaiting_approval",
  "measuring",
  "converged",
  "failed",
  "halted",
] as const);
export const goalEventKindEnum = pgEnum("goal_event_kind", [
  "plan_drafted",
  "fanout_started",
  "approval_requested",
  "approval_resolved",
  "published",
  "outcome_observed",
  "reevaluated",
  "converged",
  "halted",
  "error",
] as const);
export const experimentStatusEnum = pgEnum("experiment_status", [
  "running",
  "stopped",
  "won",
  "inconclusive",
] as const);
export const lifecycleStatusEnum = pgEnum("lifecycle_status", [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
] as const);
export const generationJobStatusEnum = pgEnum("generation_job_status", [
  "running",
  "completed",
  "failed",
] as const);
export const generationJobKindEnum = pgEnum("generation_job_kind", [
  "campaign",
  "single_post",
  "asset",
  "analysis",
  "publish",
  "research",
  "other",
] as const);
export const generationStepNameEnum = pgEnum("generation_step_name", [
  "strategist",
  "content",
  "asset",
  "analyst",
  "distributor",
  "researcher",
] as const);
export const generationStepStatusEnum = pgEnum("generation_step_status", [
  "running",
  "succeeded",
  "failed",
] as const);
export const workflowEngineEnum = pgEnum("workflow_engine", [
  "custom",
  "vercel",
  "cloudflare",
] as const);
export const workflowRunStatusEnum = pgEnum("workflow_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const);
export const brandDocStatusEnum = pgEnum("brand_doc_status", BRAND_DOC_STATUSES);
export const brandDraftStatusEnum = pgEnum(
  "brand_draft_status",
  BRAND_DRAFT_STATUSES,
);
export const extractionRunStatusEnum = pgEnum(
  "extraction_run_status",
  EXTRACTION_RUN_STATUSES,
);
export const planCodeEnum = pgEnum("plan_code", PLAN_CODES);
export const subscriptionStatusEnum = pgEnum(
  "subscription_status",
  SUBSCRIPTION_STATUSES,
);
export const billingProviderEnum = pgEnum("billing_provider", BILLING_PROVIDERS);
export const billingPeriodEnum = pgEnum("billing_period", BILLING_PERIODS);
export const workspaceRoleEnum = pgEnum("workspace_role", WORKSPACE_ROLES);
export const adminRoleEnum = pgEnum("admin_role", ADMIN_ROLES);

// --- campaigns ----------------------------------------------------------------

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // SaaS tenant. The DB column is NOT NULL after migration 0027; the TS
    // type stays nullable until PR 5 plumbs workspace_id into every insert
    // site (orchestrator, workflows, agents). Applies to every tenant
    // table below — comment lives here so it isn't repeated 25 times.
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: campaignStatusEnum("status").notNull().default("draft"),
    phase: campaignPhaseEnum("phase").notNull().default("buildup"),
    ownerId: uuid("owner_id"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    briefMd: text("brief_md"),
    calendarJson: jsonb("calendar_json"),
    // Campaign-level visual identity (migration 0029). Set by the Strategist
    // alongside the calendar; consumed by the Art Director when refining
    // per-post image briefs into prompts. Shape lives in
    // packages/agents/src/sub-agents/strategist.ts as VisualIdentity.
    visualIdentity: jsonb("visual_identity"),
    // Goal-loop fields (migration 0016). See apps/web/workflows/goal-loop.ts.
    goalDefinition: jsonb("goal_definition"),
    targetMetrics: jsonb("target_metrics"),
    loopStatus: loopStatusEnum("loop_status").notNull().default("idle"),
    loopIteration: integer("loop_iteration").notNull().default(0),
    budgetCents: integer("budget_cents"),
    costCentsSpent: integer("cost_cents_spent").notNull().default(0),
    deadline: timestamp("deadline", { withTimezone: true }),
    lastIterationAt: timestamp("last_iteration_at", { withTimezone: true }),
    parentGoalId: uuid("parent_goal_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Slug uniqueness scoped per tenant — migrated from a global unique
    // by 0027 so two workspaces can each have their own "summer-launch".
    workspaceSlugUq: uniqueIndex("campaigns_workspace_slug_uq").on(
      t.workspaceId,
      t.slug,
    ),
    statusIdx: index("campaigns_status_idx").on(t.status),
    loopStatusIdx: index("campaigns_loop_status_idx").on(t.loopStatus),
    workspaceIdx: index("campaigns_workspace_idx").on(t.workspaceId),
  }),
);

// --- content_items ------------------------------------------------------------

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Denormalized from campaigns.workspace_id so RLS / scoped reads don't
    // need a join. Backfilled in PR 3 and kept in sync by app code.
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    type: contentTypeEnum("type").notNull(),
    stage: contentStageEnum("stage").notNull().default("explain"),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    channelHints: jsonb("channel_hints"),
    status: contentStatusEnum("status").notNull().default("draft"),
    // Per-post toggle. When true (default), submit triggers Replicate variant
    // generation. When false, the approval card renders without imagery and
    // any [IMAGE N: ...] markers in the body are shown as plain text.
    needsImages: boolean("needs_images").notNull().default(true),
    // Per-post video toggle (migration 0032). Mirrors needs_images. When
    // false, kickVideoVariantStep / generateVideoVariant short-circuit. The
    // existing contentTypeWantsVideo() gate still applies on top — flipping
    // this on for a blog/email type still produces no video.
    needsVideo: boolean("needs_video").notNull().default(true),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedUrl: text("published_url"),
    // Set after a revision row is inserted; nullable until first revision.
    currentRevisionId: uuid("current_revision_id"),
    // A/B variant fields (migration 0017). variant_group is a uuid shared
    // by sibling variants; variant_index is 0-based within the group;
    // experiment_id is set when the variants are part of a registered
    // experiment (FK wired in 0018).
    variantGroup: uuid("variant_group"),
    variantIndex: integer("variant_index"),
    experimentId: uuid("experiment_id"),
    seoMeta: jsonb("seo_meta"),
    // Structured visual concept brief emitted by the Art Director and reused
    // by every downstream modality (image, video, future carousel/slide
    // generators). Schema lives in art-director.ts as VisualConceptBrief —
    // free-form jsonb here so the brief shape can evolve without migrations.
    visualBrief: jsonb("visual_brief"),
    // Per-post image brief (migration 0029) emitted by the Content agent at
    // draft time. Names the literal subject + composition + must-show /
    // must-not-show. The Art Director refines this into the model prompt
    // instead of guessing visuals from the body. Shape lives in
    // packages/agents/src/sub-agents/content.ts as ImageBrief.
    imageBrief: jsonb("image_brief"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    campaignIdx: index("content_items_campaign_idx").on(t.campaignId),
    statusIdx: index("content_items_status_idx").on(t.status),
    stageIdx: index("content_items_stage_idx").on(t.stage),
    variantGroupIdx: index("content_items_variant_group_idx").on(t.variantGroup),
    experimentIdx: index("content_items_experiment_idx").on(t.experimentId),
    workspaceIdx: index("content_items_workspace_idx").on(t.workspaceId),
  }),
);

// --- content_revisions --------------------------------------------------------

export const contentRevisions = pgTable(
  "content_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    bodyMd: text("body_md").notNull(),
    changeNote: text("change_note"),
    authorId: uuid("author_id"),
    authorKind: actorKindEnum("author_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    contentIdx: index("content_revisions_content_idx").on(t.contentId),
    workspaceIdx: index("content_revisions_workspace_idx").on(t.workspaceId),
  }),
);

// --- approvals ----------------------------------------------------------------

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decision: approvalDecisionEnum("decision"),
    decidedBy: uuid("decided_by"),
    reason: text("reason"),
  },
  (t) => ({
    contentIdx: index("approvals_content_idx").on(t.contentId),
    workspaceIdx: index("approvals_workspace_idx").on(t.workspaceId),
  }),
);

// --- publish_jobs -------------------------------------------------------------

export const publishJobs = pgTable(
  "publish_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: publishJobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    error: text("error"),
    threadRef: text("thread_ref"),
    mode: publishJobModeEnum("mode").notNull().default("live"),
    requestedBy: uuid("requested_by"),
    // Lifecycle/CRM (migration 0019). Both null for one-off publishes.
    sequenceId: uuid("sequence_id"),
    sequenceStepIndex: integer("sequence_step_index"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    contentIdx: index("publish_jobs_content_idx").on(t.contentId),
    statusIdx: index("publish_jobs_status_idx").on(t.status),
    channelIdx: index("publish_jobs_channel_idx").on(t.channel),
    // Used by the channel-cap check (Phase 6 Day 6).
    channelCreatedIdx: index("publish_jobs_channel_created_idx").on(
      t.channel,
      t.createdAt,
    ),
    sequenceIdx: index("publish_jobs_sequence_idx").on(t.sequenceId),
    workspaceIdx: index("publish_jobs_workspace_idx").on(t.workspaceId),
  }),
);

// --- assets -------------------------------------------------------------------

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentId: uuid("content_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    kind: assetKindEnum("kind").notNull(),
    status: assetStatusEnum("status").notNull().default("draft"),
    storagePath: text("storage_path").notNull(),
    templateId: text("template_id"),
    promptUsed: text("prompt_used"),
    // Set for any asset that isn't a vanilla image/png (e.g. Veo MP4 video).
    // Null on legacy rows; cards fall back to image/png in that case.
    mimeType: text("mime_type"),
    // Duration in whole seconds for video assets. Null for stills.
    durationSec: integer("duration_sec"),
    // Asset Judge's structured score (axes + verdict + reason). Free-form
    // jsonb so the score shape can evolve. judgeTotal is the denormalized
    // scalar used by the learning loop's "high-scoring assets" queries.
    judgeScore: jsonb("judge_score"),
    judgeTotal: numeric("judge_total", { precision: 5, scale: 2 }),
    judgeVerdict: text("judge_verdict"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    contentIdx: index("assets_content_idx").on(t.contentId),
    judgeTotalIdx: index("assets_judge_total_idx").on(t.judgeTotal),
    workspaceIdx: index("assets_workspace_idx").on(t.workspaceId),
  }),
);

// --- metrics ------------------------------------------------------------------

export const metrics = pgTable(
  "metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopeType: scopeTypeEnum("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    channel: channelEnum("channel"),
    metric: text("metric").notNull(),
    value: numeric("value", { precision: 20, scale: 4 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    scopeIdx: index("metrics_scope_idx").on(t.scopeType, t.scopeId),
    metricIdx: index("metrics_metric_idx").on(t.metric),
    workspaceIdx: index("metrics_workspace_idx").on(t.workspaceId),
  }),
);

// --- audit_log ----------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    actorId: uuid("actor_id"),
    actorKind: actorKindEnum("actor_kind").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index("audit_log_entity_idx").on(t.entityType, t.entityId),
    atIdx: index("audit_log_at_idx").on(t.at),
    workspaceIdx: index("audit_log_workspace_idx").on(t.workspaceId, t.at),
  }),
);

// --- agent_feedback -----------------------------------------------------------
// Captures every approval decision for future fine-tuning.
// Phase 4 add-on. See plan §Phase 11 for the retrieval layer.

export const agentFeedback = pgTable(
  "agent_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    // The revision ID that was being reviewed.
    revisionId: uuid("revision_id"),
    // The raw AI draft at submission time (snapshot).
    aiDraftMd: text("ai_draft_md").notNull(),
    // The final human-edited version (null until approved).
    humanFinalMd: text("human_final_md"),
    decision: approvalDecisionEnum("decision").notNull(),
    // Levenshtein distance between aiDraftMd and humanFinalMd.
    // Null until the final version is known (i.e. on 'approved' decisions).
    editDistance: integer("edit_distance"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
  },
  (t) => ({
    contentIdx: index("agent_feedback_content_idx").on(t.contentId),
    decisionIdx: index("agent_feedback_decision_idx").on(t.decision),
    decidedAtIdx: index("agent_feedback_decided_at_idx").on(t.decidedAt),
    workspaceIdx: index("agent_feedback_workspace_idx").on(t.workspaceId),
  }),
);

// --- outcomes -----------------------------------------------------------------
// Pre-rolled performance windows: one row per content × channel × window.
// Computed nightly by the rollup cron. Idempotent (upsert).

export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    // 7d | 30d | 90d
    window: text("window").notNull().$type<"7d" | "30d" | "90d">(),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    ctr: numeric("ctr", { precision: 10, scale: 6 }).notNull().default("0"),
    conversions: integer("conversions").notNull().default(0),
    engagementRate: numeric("engagement_rate", { precision: 10, scale: 6 }).notNull().default("0"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    contentChannelWindowUq: uniqueIndex("outcomes_content_channel_window_uq").on(
      t.contentId,
      t.channel,
      t.window,
    ),
    ctrIdx: index("outcomes_ctr_idx").on(t.ctr),
    channelIdx: index("outcomes_channel_idx").on(t.channel),
    workspaceIdx: index("outcomes_workspace_idx").on(t.workspaceId),
  }),
);

// --- embeddings (generic) -----------------------------------------------------
// Content vectors use source_type='content' and source_id = content_items.id (text).
// Legacy `content_embeddings` table dropped in migration 0003_drop_content_embeddings.
// Stores vectors for any source_type:
//   - 'content'       → approved ContentItem (source_id = content_items.id)
//   - 'brand_doc'     → brand/ICP/positioning Markdown chunk (source_id = filename:chunk)
//   - 'rejected_draft'→ agent_feedback row (source_id = agent_feedback.id)
// Partial ivfflat indexes per source_type are created in migration SQL.

export const embeddings = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Critical for tenant isolation: a missing where-clause here would leak
    // RAG context across tenants. PR 9 adds an RLS policy specifically on
    // this column and runs ANN queries through a dedicated DB role.
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceType: embeddingSourceTypeEnum("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    text: text("text").notNull().default(""),
    embedding: vector("embedding", 1536).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    model: text("model").notNull().default("text-embedding-3-small"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceUq: uniqueIndex("embeddings_source_uq").on(t.sourceType, t.sourceId, t.chunkIndex),
    sourceTypeIdx: index("embeddings_source_type_idx").on(t.sourceType),
    sourceIdIdx: index("embeddings_source_id_idx").on(t.sourceId),
    workspaceIdx: index("embeddings_workspace_idx").on(t.workspaceId),
  }),
);

// --- brand_memory -------------------------------------------------------------
// Editable brand/product documents that used to live as Markdown files in
// apps/manager/memory/{brand,product}/*.md. Moved to the DB so non-engineers
// can edit voice / ICP / positioning / visual / product state from the admin
// UI without a PR. The manager reads these on every sub-agent run and falls
// back to the file copies in apps/manager/memory if a row is missing.
//
// Slug values are constrained at the application layer to BRAND_MEMORY_SLUGS
// in @marketing/shared-types.

// campaign_id NULL ⇒ global default. A row with the same slug + a non-null
// campaign_id wins for that campaign. Uniqueness is enforced by two partial
// indexes declared in migration 0008 (Drizzle's index() doesn't model partial
// indexes here, so we keep them as raw SQL).
export const brandMemory = pgTable(
  "brand_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, {
      onDelete: "cascade",
    }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    campaignIdx: index("brand_memory_campaign_idx").on(t.campaignId),
    workspaceIdx: index("brand_memory_workspace_idx").on(t.workspaceId),
  }),
);

// --- brand_design_system ------------------------------------------------------
// Structured palette / typography / logo / token store. Sister table to
// brand_memory: one is freeform Markdown the agents read, the other is
// machine-friendly tokens the asset sub-agent passes into image-gen prompts
// and the admin UI renders as swatches and previews.
//
// Single 'default' row today; the slug column leaves the door open to
// multi-brand installs without another migration.

// Same campaign-override pattern as brand_memory (see migration 0008).
// A campaign-scoped row is a full snapshot, not a JSON patch — to override
// only colors, copy the global row first, then edit. This keeps the read
// path a single SELECT.
export const brandDesignSystem = pgTable(
  "brand_design_system",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, {
      onDelete: "cascade",
    }),
    slug: text("slug").notNull().default("default"),
    colors: jsonb("colors")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<DesignColor[]>(),
    typography: jsonb("typography")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<DesignTypography>(),
    logos: jsonb("logos")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<DesignLogo[]>(),
    tokens: jsonb("tokens")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<DesignTokens>(),
    // Beyond colors/type/logos: signature compositions, banned aesthetics,
    // motion language, mood, etc. Read by the Art Director sub-agent before
    // any image-gen step (migration 0020). Free-form jsonb to evolve fast.
    visualLanguage: jsonb("visual_language")
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    campaignIdx: index("brand_design_system_campaign_idx").on(t.campaignId),
    workspaceIdx: index("brand_design_system_workspace_idx").on(t.workspaceId),
  }),
);

// --- brand_documents ----------------------------------------------------------
// Raw uploads (PDF/DOCX/MD/TXT) that feed the brand-extractor pipeline.
// Files live in the existing `assets` Supabase bucket under the `brand-docs/`
// prefix; this table is the catalog + status tracker.
//
// Soft-delete via `removed_at`: removing a doc keeps the row for audit but
// excludes it from future extraction runs. Embeddings are purged on remove
// (handled by the API route, not the DB).

export const brandDocuments = pgTable(
  "brand_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storagePath: text("storage_path").notNull(),
    parsedTextPath: text("parsed_text_path"),
    pageCount: integer("page_count"),
    status: brandDocStatusEnum("status").notNull().default("uploaded"),
    error: text("error"),
    uploadedBy: uuid("uploaded_by"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index("brand_documents_status_idx").on(t.status),
    uploadedAtIdx: index("brand_documents_uploaded_at_idx").on(t.uploadedAt),
    workspaceIdx: index("brand_documents_workspace_idx").on(t.workspaceId),
  }),
);

// --- extraction_runs ----------------------------------------------------------
// One row per re-extraction kicked off from /brand/documents. Captures which
// doc IDs were in the corpus at run time so a draft can be traced back to
// the exact set of inputs that produced it.

export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    triggeredBy: uuid("triggered_by"),
    status: extractionRunStatusEnum("status").notNull().default("running"),
    sourceDocIds: jsonb("source_doc_ids")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    model: text("model"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index("extraction_runs_status_idx").on(t.status),
    startedIdx: index("extraction_runs_started_idx").on(t.startedAt),
    workspaceIdx: index("extraction_runs_workspace_idx").on(t.workspaceId),
  }),
);

// --- brand_memory_drafts ------------------------------------------------------
// Per-slug drafts produced by the extractor. The human reviews on /brand and
// approves/rejects; on approve, the body is upserted into brand_memory via
// the existing PUT path. Drafts are kept for audit.
//
// Status transitions:
//   pending → approved   (human accepted; brand_memory was updated)
//   pending → rejected   (human rejected; brand_memory untouched)
//   pending → superseded (a newer extraction run produced a fresh draft for
//                         the same slug while this one was still pending)

export const brandMemoryDrafts = pgTable(
  "brand_memory_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => extractionRuns.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    aiBody: text("ai_body").notNull().default(""),
    humanBody: text("human_body"),
    status: brandDraftStatusEnum("status").notNull().default("pending"),
    confidence: numeric("confidence"),
    citations: jsonb("citations")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<BrandDraftCitation[]>(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    slugIdx: index("brand_memory_drafts_slug_idx").on(t.slug),
    statusIdx: index("brand_memory_drafts_status_idx").on(t.status),
    runIdx: index("brand_memory_drafts_run_idx").on(t.runId),
    workspaceIdx: index("brand_memory_drafts_workspace_idx").on(t.workspaceId),
  }),
);

// --- generation_jobs ----------------------------------------------------------
// Per-request tracking of orchestrator runs. One row per chat turn that
// actually invokes a sub-agent. Pure observability — does not change the
// orchestrator/sub-agent control flow.

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadRef: text("thread_ref"),
    // TODO PR 3: retype to uuid once backfill maps legacy literals like
    // "admin" to a real auth.users.id.
    userId: text("user_id"),
    userMessage: text("user_message").notNull(),
    kind: generationJobKindEnum("kind").notNull().default("other"),
    status: generationJobStatusEnum("status").notNull().default("running"),
    currentStep: generationStepNameEnum("current_step"),
    campaignId: uuid("campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    contentId: uuid("content_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index("generation_jobs_status_idx").on(t.status),
    threadIdx: index("generation_jobs_thread_idx").on(t.threadRef),
    createdIdx: index("generation_jobs_created_idx").on(t.createdAt),
    workspaceIdx: index("generation_jobs_workspace_idx").on(t.workspaceId),
  }),
);

// --- generation_job_steps -----------------------------------------------------
// One row per sub-agent invocation inside a generation_job. Started as
// 'running' and patched to 'succeeded' / 'failed' when the agent returns.

export const generationJobSteps = pgTable(
  "generation_job_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    name: generationStepNameEnum("name").notNull(),
    status: generationStepStatusEnum("status").notNull().default("running"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    jobIdx: index("generation_job_steps_job_idx").on(t.jobId),
    startedIdx: index("generation_job_steps_started_idx").on(t.startedAt),
  }),
);

// --- workflow_runs ------------------------------------------------------------
// Engine-agnostic dashboard layer. Every workflow run, regardless of which
// backend executes it, writes one row here at start and updates status on
// completion. engine_run_ref points back to the engine-native id (e.g.
// generation_jobs.id for custom, the Vercel run id for vercel) so the page
// can join through to engine-specific detail.

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    engine: workflowEngineEnum("engine").notNull(),
    kind: generationJobKindEnum("kind").notNull(),
    status: workflowRunStatusEnum("status").notNull().default("queued"),
    request: text("request").notNull(),
    threadRef: text("thread_ref"),
    userId: text("user_id"),
    engineRunRef: text("engine_run_ref"),
    campaignId: uuid("campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    contentId: uuid("content_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    input: jsonb("input"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    engineIdx: index("workflow_runs_engine_idx").on(t.engine),
    statusIdx: index("workflow_runs_status_idx").on(t.status),
    threadIdx: index("workflow_runs_thread_idx").on(t.threadRef),
    createdIdx: index("workflow_runs_created_idx").on(t.createdAt),
    engineRefIdx: index("workflow_runs_engine_ref_idx").on(t.engineRunRef),
    workspaceIdx: index("workflow_runs_workspace_idx").on(t.workspaceId),
  }),
);

// --- llm_usage ----------------------------------------------------------------
// One row per LLM call. Written by recordLlmUsage in @marketing/agents/usage,
// read by the /api/usage aggregate endpoint and rendered on the settings page.
// cost_usd is computed at write time from the static price map in
// shared-types so historical rows stay accurate even if rates change later.

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stamped at write time by recordLlmUsage once PR 5 lands. Without this
    // we can't attribute LLM spend to a tenant for cost dashboards.
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // strategist | content | asset | analyst | orchestrator | single-post …
    agent: text("agent").notNull(),
    threadRef: text("thread_ref"),
    jobId: uuid("job_id"),
    // Engine-agnostic workflow run this call belongs to. Lets the
    // /api/usage/by-workflow endpoint sum tokens per run regardless of
    // which engine (custom/vercel/cloudflare) executed it. Nullable for
    // calls outside any workflow (e.g. chat orchestrator turns).
    workflowRunId: uuid("workflow_run_id").references(
      () => workflowRuns.id,
      { onDelete: "set null" },
    ),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    // Null when the model isn't in the price map (e.g. a brand-new id we
    // haven't priced yet); the row is still useful for token aggregates.
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    error: text("error"),
  },
  (t) => ({
    occurredIdx: index("llm_usage_occurred_at_idx").on(t.occurredAt),
    modelIdx: index("llm_usage_model_idx").on(t.model),
    agentIdx: index("llm_usage_agent_idx").on(t.agent),
    workflowRunIdx: index("llm_usage_workflow_run_idx").on(t.workflowRunId),
    workspaceIdx: index("llm_usage_workspace_idx").on(
      t.workspaceId,
      t.occurredAt,
    ),
  }),
);

// --- settings -----------------------------------------------------------------
// PR 4: per-workspace settings with a global fallback row (workspace_id IS NULL).
// PK is the composite (workspace_id, key); a partial unique enforces "at most
// one global row per key" because the composite PK alone would allow many
// (NULL, key) duplicates. The legacy `settings_pkey` is dropped in 0028.
//
// Read path: SELECT workspace row first; if missing for that key, fall back
// to the global row. The /api/settings handler does this merge in JS so the
// shape returned to the UI stays a single flat object.

export const settings = pgTable(
  "settings",
  {
    // NULL is meaningful here: rows with a null workspace_id are the global
    // default values that apply when a tenant hasn't overridden a setting.
    // Do NOT add .notNull() — see migration 0028_settings_per_workspace.sql.
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Composite PK enforced via 0028's hand-written SQL because Drizzle
    // doesn't model nullable-aware composite PKs well; the migration adds
    // both a regular PK on (coalesce(workspace_id, '00000000'…), key) and
    // a partial unique for the global-fallback semantic.
    workspaceKeyIdx: index("settings_workspace_key_idx").on(
      t.workspaceId,
      t.key,
    ),
  }),
);

// --- SaaS foundation (PR 1) ---------------------------------------------------
// Tenant, billing, and metering tables. Nothing reads these in PR 1; the app
// continues to operate against the legacy single-tenant data set. PRs 2–9 will
// wire entitlement checks, scoping, admin UI, and Khalti webhooks against them.

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    // auth.users(id). No FK — same pattern as campaigns.owner_id, see comment
    // at the top of this file.
    ownerUserId: uuid("owner_user_id").notNull(),
    // Denormalized current plan. Authoritative source is the latest
    // subscriptions row in ('trialing','active','past_due','grace').
    planId: uuid("plan_id").notNull(),
    // When non-null, billing changes are suppressed until this date; the
    // workspace stays on planId regardless of subscription status. Used by
    // superadmins to park enterprise / free-friend tenants on a plan.
    planOverriddenUntil: timestamp("plan_overridden_until", {
      withTimezone: true,
    }),
    // Market context — the "Place" of the 4 Ps. Read by every strategist run
    // so generated content matches the actual geography, language, and
    // distribution channels of the workspace's business. Freeform nuance
    // (pricing story, cultural notes, promotion mix) lives in the
    // `market.context` brand_memory slug; these columns hold the structured
    // fields downstream code can route on (channel selection, locale, etc.).
    primaryCountry: text("primary_country"),
    targetRegions: text("target_regions").array(),
    languages: text("languages").array(),
    primaryChannels: text("primary_channels").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    slugUq: uniqueIndex("workspaces_slug_uq").on(t.slug),
    ownerIdx: index("workspaces_owner_idx").on(t.ownerUserId),
    planIdx: index("workspaces_plan_idx").on(t.planId),
  }),
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Null while an invite is pending; set on acceptance.
    userId: uuid("user_id"),
    role: workspaceRoleEnum("role").notNull(),
    // Invitation fields. invitedEmail + invitedToken are set when the row is
    // created from an invite; both cleared on acceptance.
    invitedEmail: text("invited_email"),
    invitedToken: text("invited_token"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // A user can only hold one role per workspace. Enforced as a partial
    // unique on accepted memberships in 0024 (Drizzle's uniqueIndex can't
    // express partials; see migration SQL).
    workspaceUserUq: uniqueIndex("workspace_members_workspace_user_uq").on(
      t.workspaceId,
      t.userId,
    ),
    userIdx: index("workspace_members_user_idx").on(t.userId),
    tokenIdx: uniqueIndex("workspace_members_invited_token_uq").on(
      t.invitedToken,
    ),
  }),
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: planCodeEnum("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priceMonthlyNpr: integer("price_monthly_npr").notNull().default(0),
    priceYearlyNpr: integer("price_yearly_npr").notNull().default(0),
    // Stripe lives in cents; nullable until Stripe is wired in PR 10.
    priceMonthlyUsdCents: integer("price_monthly_usd_cents"),
    priceYearlyUsdCents: integer("price_yearly_usd_cents"),
    // Static catalog snapshots — typed in @marketing/shared-types/billing.
    // Stored as jsonb so plan changes don't require schema migrations.
    features: jsonb("features").notNull().default(sql`'{}'::jsonb`),
    quotas: jsonb("quotas").notNull().default(sql`'{}'::jsonb`),
    isPublic: boolean("is_public").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    codeUq: uniqueIndex("plans_code_uq").on(t.code),
    publicIdx: index("plans_public_sort_idx").on(t.isPublic, t.sortOrder),
  }),
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    status: subscriptionStatusEnum("status").notNull(),
    provider: billingProviderEnum("provider").notNull(),
    // Khalti has no native subscriptions, so we mint a uuid up front and
    // attach every payment in the chain to it. Stripe uses its `sub_…` id.
    providerSubscriptionId: text("provider_subscription_id"),
    providerCustomerId: text("provider_customer_id"),
    billingPeriod: billingPeriodEnum("billing_period")
      .notNull()
      .default("monthly"),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
    }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end")
      .notNull()
      .default(false),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("subscriptions_workspace_idx").on(t.workspaceId),
    // Lookups by Khalti/Stripe id from the webhook handler.
    providerSubIdx: index("subscriptions_provider_sub_idx").on(
      t.providerSubscriptionId,
    ),
    // Powers the renewal-due cron (find subs whose period ends soon).
    statusExpiryIdx: index("subscriptions_status_expiry_idx").on(
      t.status,
      t.currentPeriodEnd,
    ),
    // Partial unique "one live sub per workspace" is added in 0024 SQL
    // because Drizzle's uniqueIndex doesn't express the predicate.
  }),
);

// Append-only ledger of every payment-provider event we ingest. Idempotency
// key is (provider, provider_event_id); replaying a webhook is a no-op once
// processed_at is set. Forensics live here too.
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Both nullable while we resolve the inbound webhook to a workspace.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    subscriptionId: uuid("subscription_id").references(
      () => subscriptions.id,
      { onDelete: "set null" },
    ),
    provider: billingProviderEnum("provider").notNull(),
    // payment.succeeded | payment.failed | refund | initiated | renewed | …
    eventType: text("event_type").notNull(),
    // For Khalti KPG-2 this is the `pidx`; for Stripe, the event id.
    providerEventId: text("provider_event_id").notNull(),
    payload: jsonb("payload").notNull(),
    signature: text("signature"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingError: text("processing_error"),
  },
  (t) => ({
    providerEventUq: uniqueIndex("billing_events_provider_event_uq").on(
      t.provider,
      t.providerEventId,
    ),
    workspaceReceivedIdx: index("billing_events_workspace_received_idx").on(
      t.workspaceId,
      t.receivedAt,
    ),
    typeIdx: index("billing_events_type_idx").on(t.eventType),
  }),
);

// Append-only event log. usage_counters is the rollup; this is the truth.
// Refunds insert negative-delta rows so counters can decrement.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // One of UsageMetric from @marketing/shared-types/billing.
    metric: text("metric").notNull(),
    delta: bigint("delta", { mode: "number" }).notNull(),
    // What was the subject of this charge? E.g. workflow_run id, content_id,
    // llm_usage row id. Free-form because the metric→subject mapping evolves.
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    // Set to true when the event records a blocked attempt (delta = 0). Lets
    // dashboards show "quota-blocked X times this month" without scanning.
    blocked: boolean("blocked").notNull().default(false),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceOccurredIdx: index("usage_events_workspace_occurred_idx").on(
      t.workspaceId,
      t.occurredAt,
    ),
    metricOccurredIdx: index("usage_events_metric_occurred_idx").on(
      t.metric,
      t.occurredAt,
    ),
    subjectIdx: index("usage_events_subject_idx").on(
      t.subjectType,
      t.subjectId,
    ),
  }),
);

// Hot-path rollup. Read on every entitlement check; updated atomically in
// the same transaction as the usage_events insert. (workspace, period, metric)
// is unique; conflicts upsert by adding the delta.
export const usageCounters = pgTable(
  "usage_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // UTC month start for the canonical monthly window. Future daily caps
    // would use a separate table or a (period_kind, period_start) composite.
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    metric: text("metric").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspacePeriodMetricUq: uniqueIndex(
      "usage_counters_workspace_period_metric_uq",
    ).on(t.workspaceId, t.periodStart, t.metric),
    metricPeriodIdx: index("usage_counters_metric_period_idx").on(
      t.workspaceId,
      t.metric,
      t.periodStart,
    ),
  }),
);

// Internal operator allowlist for the /super/* console. Separate from
// workspace_members because cross-tenant access is a different authority.
// `AUTH_ALLOWLIST` env stays in place for private-beta signup gating in PR 2
// and is decommissioned for authorization once this table is populated.
export const adminUsers = pgTable(
  "admin_users",
  {
    userId: uuid("user_id").primaryKey(),
    role: adminRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

// --- kb_collections / kb_documents / kb_chunks --------------------------------
// Knowledge Base (migration 0015). Replaces the scattered file-based memory
// in apps/manager/memory/* and unifies brand_memory + brand_documents into
// one queryable surface. Each kb_chunk is embedded into the existing
// `embeddings` table with source_type='kb_chunk' and source_id=kb_chunks.id.

export const kbCollections = pgTable(
  "kb_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: kbCollectionKindEnum("kind").notNull(),
    scope: kbScopeEnum("scope").notNull().default("global"),
    campaignId: uuid("campaign_id").references(() => campaigns.id, {
      onDelete: "cascade",
    }),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Per-tenant slug uniqueness (migrated from global by 0027).
    workspaceSlugUq: uniqueIndex("kb_collections_workspace_slug_uq").on(
      t.workspaceId,
      t.slug,
    ),
    kindIdx: index("kb_collections_kind_idx").on(t.kind),
    campaignIdx: index("kb_collections_campaign_idx").on(t.campaignId),
    workspaceIdx: index("kb_collections_workspace_idx").on(t.workspaceId),
  }),
);

export const kbDocuments = pgTable(
  "kb_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => kbCollections.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    source: kbDocSourceEnum("source").notNull().default("manual"),
    sourceRef: text("source_ref"),
    bodyMd: text("body_md").notNull().default(""),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    version: integer("version").notNull().default(1),
    status: kbDocStatusEnum("status").notNull().default("active"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    collectionSlugUq: uniqueIndex("kb_documents_collection_slug_uq").on(
      t.collectionId,
      t.slug,
    ),
    statusIdx: index("kb_documents_status_idx").on(t.status),
    collectionIdx: index("kb_documents_collection_idx").on(t.collectionId),
    updatedAtIdx: index("kb_documents_updated_at_idx").on(t.updatedAt),
    workspaceIdx: index("kb_documents_workspace_idx").on(t.workspaceId),
  }),
);

export const kbChunks = pgTable(
  "kb_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => kbDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    bodyMd: text("body_md").notNull(),
    tokenCount: integer("token_count").notNull().default(0),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    docIdxUq: uniqueIndex("kb_chunks_doc_idx_uq").on(t.documentId, t.chunkIndex),
    documentIdx: index("kb_chunks_document_idx").on(t.documentId),
    workspaceIdx: index("kb_chunks_workspace_idx").on(t.workspaceId),
  }),
);

// --- goal_events --------------------------------------------------------------
// Durable trail for the goal-loop workflow (migration 0016). Combined with
// Vercel Workflows' native durable execution, lets the loop resume from the
// last completed step after a crash. (campaign_id, iteration, step_key) is
// a partial-unique idempotency key — the loop's step.do() wrappers insert
// here on first run and skip on re-run when the row already exists.

export const goalEvents = pgTable(
  "goal_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull().default(0),
    kind: goalEventKindEnum("kind").notNull(),
    stepKey: text("step_key"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignIdx: index("goal_events_campaign_idx").on(t.campaignId),
    kindIdx: index("goal_events_kind_idx").on(t.kind),
    tsIdx: index("goal_events_ts_idx").on(t.ts),
    workspaceIdx: index("goal_events_workspace_idx").on(t.workspaceId),
  }),
);

// --- experiments --------------------------------------------------------------
// A/B experiment registry (migration 0018). One row per variant_group; the
// Growth/Experiment sub-agent inserts on creation, propose_winner reads
// outcomes and sets winner_content_id once threshold is met.

export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    variantGroup: uuid("variant_group").notNull(),
    hypothesis: text("hypothesis").notNull().default(""),
    metric: text("metric").notNull().default("ctr"),
    thresholdJson: jsonb("threshold_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: experimentStatusEnum("status").notNull().default("running"),
    winnerContentId: uuid("winner_content_id").references(
      () => contentItems.id,
      { onDelete: "set null" },
    ),
    sampleSize: integer("sample_size").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    variantGroupUq: uniqueIndex("experiments_variant_group_uq").on(t.variantGroup),
    campaignIdx: index("experiments_campaign_idx").on(t.campaignId),
    statusIdx: index("experiments_status_idx").on(t.status),
    workspaceIdx: index("experiments_workspace_idx").on(t.workspaceId),
  }),
);

// --- lifecycle_sequences / lifecycle_steps ------------------------------------
// Multi-step email/lifecycle journeys (migration 0019). Each step references
// a content_items row; goal-loop schedules step k+1 by inserting a
// publish_jobs row with sequence_id + sequence_step_index after step k
// publishes.

export const lifecycleSequences = pgTable(
  "lifecycle_sequences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    channel: channelEnum("channel").notNull(),
    audienceSegment: text("audience_segment"),
    status: lifecycleStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    campaignIdx: index("lifecycle_sequences_campaign_idx").on(t.campaignId),
    statusIdx: index("lifecycle_sequences_status_idx").on(t.status),
    workspaceIdx: index("lifecycle_sequences_workspace_idx").on(t.workspaceId),
  }),
);

export const lifecycleSteps = pgTable(
  "lifecycle_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => lifecycleSequences.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    contentId: uuid("content_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    delayHours: integer("delay_hours").notNull().default(0),
    triggerEvent: text("trigger_event").notNull().default("previous_published"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sequenceIndexUq: uniqueIndex("lifecycle_steps_sequence_index_uq").on(
      t.sequenceId,
      t.stepIndex,
    ),
    contentIdx: index("lifecycle_steps_content_idx").on(t.contentId),
    workspaceIdx: index("lifecycle_steps_workspace_idx").on(t.workspaceId),
  }),
);

// --- Inferred row types -------------------------------------------------------

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type ContentItem = typeof contentItems.$inferSelect;
export type NewContentItem = typeof contentItems.$inferInsert;
export type ContentRevision = typeof contentRevisions.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type PublishJob = typeof publishJobs.$inferSelect;
export type NewPublishJob = typeof publishJobs.$inferInsert;
export type Asset = typeof assets.$inferSelect;
export type Metric = typeof metrics.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type BrandMemoryRow = typeof brandMemory.$inferSelect;
export type NewBrandMemoryRow = typeof brandMemory.$inferInsert;
export type BrandDesignSystemRow = typeof brandDesignSystem.$inferSelect;
export type NewBrandDesignSystemRow = typeof brandDesignSystem.$inferInsert;
export type AgentFeedback = typeof agentFeedback.$inferSelect;
export type NewAgentFeedback = typeof agentFeedback.$inferInsert;
export type Outcome = typeof outcomes.$inferSelect;
export type NewOutcome = typeof outcomes.$inferInsert;
export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type NewGenerationJob = typeof generationJobs.$inferInsert;
export type GenerationJobStep = typeof generationJobSteps.$inferSelect;
export type NewGenerationJobStep = typeof generationJobSteps.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
export type LlmUsage = typeof llmUsage.$inferSelect;
export type NewLlmUsage = typeof llmUsage.$inferInsert;
export type KbCollection = typeof kbCollections.$inferSelect;
export type NewKbCollection = typeof kbCollections.$inferInsert;
export type KbDocument = typeof kbDocuments.$inferSelect;
export type NewKbDocument = typeof kbDocuments.$inferInsert;
export type KbChunk = typeof kbChunks.$inferSelect;
export type NewKbChunk = typeof kbChunks.$inferInsert;
export type GoalEvent = typeof goalEvents.$inferSelect;
export type NewGoalEvent = typeof goalEvents.$inferInsert;
export type Experiment = typeof experiments.$inferSelect;
export type NewExperiment = typeof experiments.$inferInsert;
export type LifecycleSequence = typeof lifecycleSequences.$inferSelect;
export type NewLifecycleSequence = typeof lifecycleSequences.$inferInsert;
export type LifecycleStep = typeof lifecycleSteps.$inferSelect;
export type NewLifecycleStep = typeof lifecycleSteps.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type BillingEvent = typeof billingEvents.$inferSelect;
export type NewBillingEvent = typeof billingEvents.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type UsageCounter = typeof usageCounters.$inferSelect;
export type NewUsageCounter = typeof usageCounters.$inferInsert;
export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;

// Re-export enum type unions so callers don't need a second import.
export {
  CAMPAIGN_PHASES,
  CAMPAIGN_STATUSES,
  CONTENT_TYPES,
  CONTENT_STAGES,
  CONTENT_STATUSES,
  APPROVAL_DECISIONS,
  PUBLISH_JOB_STATUSES,
  ASSET_KINDS,
  ASSET_STATUSES,
  ACTOR_KINDS,
  SCOPE_TYPES,
  CHANNELS,
} from "@marketing/shared-types";

// Hint for drizzle-kit / Postgres trigger authors: the plan §3 invariant is
// that publish_jobs MUST refuse inserts when the linked content_items row is
// not status='approved'. Trigger SQL lives in infra/supabase/policies.sql.
export const PUBLISH_JOB_APPROVAL_INVARIANT = sql`/* see infra/supabase/policies.sql */`;
