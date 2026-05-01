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
export const assetKindEnum = pgEnum("asset_kind", ASSET_KINDS);
export const assetStatusEnum = pgEnum("asset_status", ASSET_STATUSES);
export const actorKindEnum = pgEnum("actor_kind", ACTOR_KINDS);
export const scopeTypeEnum = pgEnum("scope_type", SCOPE_TYPES);
export const channelEnum = pgEnum("channel", CHANNELS);
export const embeddingSourceTypeEnum = pgEnum("embedding_source_type", [
  "content",
  "brand_doc",
  "rejected_draft",
] as const);

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
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedUrl: text("published_url"),
    // Set after a revision row is inserted; nullable until first revision.
    currentRevisionId: uuid("current_revision_id"),
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
    requestedBy: uuid("requested_by"),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    contentIdx: index("assets_content_idx").on(t.contentId),
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

// --- content_embeddings -------------------------------------------------------
// text-embedding-3-small produces 1536-dimensional vectors.
// Requires: CREATE EXTENSION IF NOT EXISTS vector; (see migration SQL).

export const contentEmbeddings = pgTable(
  "content_embeddings",
  {
    contentId: uuid("content_id")
      .primaryKey()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    embedding: vector("embedding", 1536).notNull(),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }).notNull().defaultNow(),
    model: text("model").notNull().default("text-embedding-3-small"),
  },
);

// --- embeddings (generic) -----------------------------------------------------
// Replaces content_embeddings. Stores vectors for any source_type:
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
export type AgentFeedback = typeof agentFeedback.$inferSelect;
export type NewAgentFeedback = typeof agentFeedback.$inferInsert;
export type Outcome = typeof outcomes.$inferSelect;
export type NewOutcome = typeof outcomes.$inferInsert;
export type ContentEmbedding = typeof contentEmbeddings.$inferSelect;
export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;

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
