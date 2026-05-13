// SaaS plan / feature / quota catalog. Single source of truth shared by
// @marketing/db (column types) and apps/web (entitlement checks). PR 1 only
// defines the types and seed plans — nothing reads them yet.

export const PLAN_CODES = [
  "free",
  "starter",
  "growth",
  "business",
  "enterprise",
] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const BILLING_PERIODS = ["monthly", "yearly"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "grace",
  "canceled",
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_PROVIDERS = ["khalti", "stripe", "manual"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const ADMIN_ROLES = ["superadmin", "support"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

// Boolean capability flags. Anything that's "you can or can't" lives here.
export const FEATURES = [
  "asset_pipeline",
  "video_assets",
  "web_research",
  "goal_loop",
  "experiments",
  "lifecycle_sequences",
  "custom_kb_collections",
  "api_access",
  "priority_queue",
  "multi_seat",
] as const;
export type Feature = (typeof FEATURES)[number];

// Numeric caps. Quota check is `usage_counters.value + delta <= plan.quotas[metric]`.
// Sentinel: -1 means unlimited. Always check `>= 0` before comparing.
export const QUOTAS = [
  "seats",
  "orchestrator_messages",
  "sub_agent_calls",
  "single_post_runs",
  "asset_pipeline_runs",
  "kb_embeds",
  "kb_docs",
  "kb_doc_bytes",
  "published_posts",
  "llm_input_tokens",
  "llm_output_tokens",
  "llm_cost_usd_micros",
] as const;
export type Quota = (typeof QUOTAS)[number];

// Usage metrics recorded in usage_events / usage_counters. Superset of quotas
// because some metrics are observed but not capped (e.g. cached tokens).
export const USAGE_METRICS = [
  ...QUOTAS,
  "cached_input_tokens",
  "workflow_runs",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export type FeatureSet = Record<Feature, boolean>;
export type QuotaSet = Record<Quota, number>;

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  description: string;
  priceMonthlyNpr: number;
  priceYearlyNpr: number;
  priceMonthlyUsdCents: number | null;
  priceYearlyUsdCents: number | null;
  isPublic: boolean;
  sortOrder: number;
  features: FeatureSet;
  quotas: QuotaSet;
}

const NO_FEATURES: FeatureSet = {
  asset_pipeline: false,
  video_assets: false,
  web_research: false,
  goal_loop: false,
  experiments: false,
  lifecycle_sequences: false,
  custom_kb_collections: false,
  api_access: false,
  priority_queue: false,
  multi_seat: false,
};

// `quotas` defaults to zero so a new plan that forgets a metric blocks
// everything by default — fail closed. Sentinel -1 = unlimited.
const ZERO_QUOTAS: QuotaSet = {
  seats: 0,
  orchestrator_messages: 0,
  sub_agent_calls: 0,
  single_post_runs: 0,
  asset_pipeline_runs: 0,
  kb_embeds: 0,
  kb_docs: 0,
  kb_doc_bytes: 0,
  published_posts: 0,
  llm_input_tokens: 0,
  llm_output_tokens: 0,
  llm_cost_usd_micros: 0,
};

// Stable UUIDs so migrations are idempotent and seed scripts can upsert by id.
export const PLAN_IDS: Record<PlanCode, string> = {
  free: "11111111-1111-1111-1111-000000000001",
  starter: "11111111-1111-1111-1111-000000000002",
  growth: "11111111-1111-1111-1111-000000000003",
  business: "11111111-1111-1111-1111-000000000004",
  enterprise: "11111111-1111-1111-1111-000000000005",
};

export const DEFAULT_PLANS: PlanDefinition[] = [
  {
    code: "free",
    name: "Free",
    description: "Evaluate the product. Watermarked outputs, single user.",
    priceMonthlyNpr: 0,
    priceYearlyNpr: 0,
    priceMonthlyUsdCents: 0,
    priceYearlyUsdCents: 0,
    isPublic: true,
    sortOrder: 0,
    features: { ...NO_FEATURES },
    quotas: {
      ...ZERO_QUOTAS,
      seats: 1,
      orchestrator_messages: 50,
      sub_agent_calls: 100,
      single_post_runs: 10,
      kb_docs: 5,
      kb_doc_bytes: 10 * 1024 * 1024,
      kb_embeds: 50,
      published_posts: 5,
      llm_input_tokens: 200_000,
      llm_output_tokens: 50_000,
      llm_cost_usd_micros: 1_000_000, // $1 hard cap
    },
  },
  {
    code: "starter",
    name: "Starter",
    description: "Solo marketers and freelancers.",
    priceMonthlyNpr: 2_499,
    priceYearlyNpr: 24_990,
    priceMonthlyUsdCents: 2_900,
    priceYearlyUsdCents: 29_000,
    isPublic: true,
    sortOrder: 1,
    features: {
      ...NO_FEATURES,
      multi_seat: true,
    },
    quotas: {
      ...ZERO_QUOTAS,
      seats: 2,
      orchestrator_messages: 500,
      sub_agent_calls: 1_500,
      single_post_runs: 100,
      asset_pipeline_runs: 0, // starter has manual assets only
      kb_docs: 50,
      kb_doc_bytes: 100 * 1024 * 1024,
      kb_embeds: 500,
      published_posts: 60,
      llm_input_tokens: 2_000_000,
      llm_output_tokens: 500_000,
      llm_cost_usd_micros: 20_000_000, // $20
    },
  },
  {
    code: "growth",
    name: "Growth",
    description: "SMBs and small agencies. Asset pipeline + research.",
    priceMonthlyNpr: 7_999,
    priceYearlyNpr: 79_990,
    priceMonthlyUsdCents: 8_900,
    priceYearlyUsdCents: 89_000,
    isPublic: true,
    sortOrder: 2,
    features: {
      ...NO_FEATURES,
      multi_seat: true,
      asset_pipeline: true,
      web_research: true,
      goal_loop: true,
      experiments: true,
    },
    quotas: {
      ...ZERO_QUOTAS,
      seats: 5,
      orchestrator_messages: 3_000,
      sub_agent_calls: 10_000,
      single_post_runs: 500,
      asset_pipeline_runs: 200,
      kb_docs: 500,
      kb_doc_bytes: 1024 * 1024 * 1024,
      kb_embeds: 5_000,
      published_posts: 300,
      llm_input_tokens: 15_000_000,
      llm_output_tokens: 3_000_000,
      llm_cost_usd_micros: 80_000_000, // $80
    },
  },
  {
    code: "business",
    name: "Business",
    description: "Agencies and mid-market. Multi-brand, video, API, lifecycle.",
    priceMonthlyNpr: 24_999,
    priceYearlyNpr: 249_990,
    priceMonthlyUsdCents: 24_900,
    priceYearlyUsdCents: 249_000,
    isPublic: true,
    sortOrder: 3,
    features: {
      ...NO_FEATURES,
      multi_seat: true,
      asset_pipeline: true,
      video_assets: true,
      web_research: true,
      goal_loop: true,
      experiments: true,
      lifecycle_sequences: true,
      custom_kb_collections: true,
      api_access: true,
      priority_queue: true,
    },
    quotas: {
      ...ZERO_QUOTAS,
      seats: 15,
      orchestrator_messages: 15_000,
      sub_agent_calls: 50_000,
      single_post_runs: 2_500,
      asset_pipeline_runs: 1_000,
      kb_docs: 5_000,
      kb_doc_bytes: 10 * 1024 * 1024 * 1024,
      kb_embeds: 50_000,
      published_posts: 1_500,
      llm_input_tokens: 75_000_000,
      llm_output_tokens: 15_000_000,
      llm_cost_usd_micros: 250_000_000, // $250
    },
  },
  {
    code: "enterprise",
    name: "Enterprise",
    description: "Custom limits, SSO, dedicated infra, SLAs. Talk to sales.",
    priceMonthlyNpr: 75_000,
    priceYearlyNpr: 750_000,
    priceMonthlyUsdCents: 75_000,
    priceYearlyUsdCents: 750_000,
    isPublic: false,
    sortOrder: 4,
    features: {
      ...NO_FEATURES,
      multi_seat: true,
      asset_pipeline: true,
      video_assets: true,
      web_research: true,
      goal_loop: true,
      experiments: true,
      lifecycle_sequences: true,
      custom_kb_collections: true,
      api_access: true,
      priority_queue: true,
    },
    quotas: {
      // -1 = unlimited; entitlement check treats < 0 as no cap.
      seats: 50,
      orchestrator_messages: -1,
      sub_agent_calls: -1,
      single_post_runs: -1,
      asset_pipeline_runs: -1,
      kb_docs: -1,
      kb_doc_bytes: -1,
      kb_embeds: -1,
      published_posts: -1,
      llm_input_tokens: -1,
      llm_output_tokens: -1,
      llm_cost_usd_micros: -1,
    },
  },
];

export function findDefaultPlan(code: PlanCode): PlanDefinition {
  const p = DEFAULT_PLANS.find((x) => x.code === code);
  if (!p) throw new Error(`unknown plan code: ${code}`);
  return p;
}

export function isUnlimited(quotaValue: number): boolean {
  return quotaValue < 0;
}
