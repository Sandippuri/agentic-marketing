// Enum string-literal unions. Drizzle pgEnum values must match these exactly.
// Plan §3.

export const CAMPAIGN_PHASES = ["buildup", "launch", "post_launch"] as const;
export type CampaignPhase = (typeof CAMPAIGN_PHASES)[number];

export const CAMPAIGN_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CONTENT_TYPES = [
  "blog",
  "linkedin",
  "x_thread",
  "x_post",
  "email",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_STAGES = [
  "pull",
  "explain",
  "reinforce",
  "push",
] as const;
export type ContentStage = (typeof CONTENT_STAGES)[number];

export const CONTENT_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "retracted",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const APPROVAL_DECISIONS = [
  "approved",
  "changes_requested",
  "rejected",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const PUBLISH_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PublishJobStatus = (typeof PUBLISH_JOB_STATUSES)[number];

export const ASSET_KINDS = [
  "poster",
  "hero",
  "og",
  "email_header",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "published",
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ACTOR_KINDS = ["human", "agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const SCOPE_TYPES = ["content", "campaign"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const CHANNELS = [
  "internal_blog",
  "linkedin",
  "x",
  "email_hubspot",
  "email_mailchimp",
] as const;
export type Channel = (typeof CHANNELS)[number];

// --- Adapter contract (Phase 6 Day 1) -------------------------------------

export type AdapterPublishResult = {
  externalId: string;
  externalUrl: string;
  // Optional: when a multi-step publish (e.g. X thread) partially fails.
  partialExternalIds?: string[];
};

export interface PublishingAdapter<TPayload = unknown> {
  readonly channel: Channel;
  publish(payload: TPayload): Promise<AdapterPublishResult>;
  retract(externalId: string): Promise<void>;
  // Optional: pulled by the analyst at metric-collection time.
  fetchMetrics?(externalId: string): Promise<Record<string, number>>;
}

// --- Thread refs (Phase 2 Day 3) ------------------------------------------

export type ThreadRef =
  | `slack:C${string}:T${string}`
  | `discord:C${string}:T${string}`;

// --- Settings keys (typed) ------------------------------------------------

export type ChannelCaps = Partial<Record<Channel, number>>;

export type SettingsShape = {
  kill_switch: boolean;
  channel_caps: ChannelCaps;
  approval_policy: { mode: "single" | "two_approver"; channels?: Channel[] };
};
