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
  "other",
] as const);
export const generationStepNameEnum = pgEnum("generation_step_name", [
  "strategist",
  "content",
  "asset",
  "analyst",
  "distributor",
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

// --- campaigns ----------------------------------------------------------------

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: campaignStatusEnum("status").notNull().default("draft"),
    phase: campaignPhaseEnum("phase").notNull().default("buildup"),
    ownerId: uuid("owner_id"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    briefMd: text("brief_md"),
    calendarJson: jsonb("calendar_json"),
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
    slugUq: uniqueIndex("campaigns_slug_uq").on(t.slug),
    statusIdx: index("campaigns_status_idx").on(t.status),
    loopStatusIdx: index("campaigns_loop_status_idx").on(t.loopStatus),
  }),
);

// --- content_items ------------------------------------------------------------

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

// --- content_revisions --------------------------------------------------------

export const contentRevisions = pgTable(
  "content_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

// --- approvals ----------------------------------------------------------------

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

// --- publish_jobs -------------------------------------------------------------

export const publishJobs = pgTable(
  "publish_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

// --- assets -------------------------------------------------------------------

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

// --- metrics ------------------------------------------------------------------

export const metrics = pgTable(
  "metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

// --- audit_log ----------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

// --- agent_feedback -----------------------------------------------------------
// Captures every approval decision for future fine-tuning.
// Phase 4 add-on. See plan §Phase 11 for the retrieval layer.

export const agentFeedback = pgTable(
  "agent_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

// --- outcomes -----------------------------------------------------------------
// Pre-rolled performance windows: one row per content × channel × window.
// Computed nightly by the rollup cron. Idempotent (upsert).

export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    threadRef: text("thread_ref"),
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
  }),
);

// --- settings -----------------------------------------------------------------

export const settings = pgTable(
  "settings",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
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
    slugUq: uniqueIndex("kb_collections_slug_uq").on(t.slug),
    kindIdx: index("kb_collections_kind_idx").on(t.kind),
    campaignIdx: index("kb_collections_campaign_idx").on(t.campaignId),
  }),
);

export const kbDocuments = pgTable(
  "kb_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

export const kbChunks = pgTable(
  "kb_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  }),
);

export const lifecycleSteps = pgTable(
  "lifecycle_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
