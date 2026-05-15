// Enum string-literal unions. Drizzle pgEnum values must match these exactly.
// Plan §3.

export { parseRationale } from "./rationale";
export {
  PLAN_CODES,
  BILLING_PERIODS,
  SUBSCRIPTION_STATUSES,
  BILLING_PROVIDERS,
  WORKSPACE_ROLES,
  ADMIN_ROLES,
  FEATURES,
  QUOTAS,
  USAGE_METRICS,
  DEFAULT_PLANS,
  PLAN_IDS,
  findDefaultPlan,
  isUnlimited,
} from "./billing";
export type {
  PlanCode,
  BillingPeriod,
  SubscriptionStatus,
  BillingProvider,
  WorkspaceRole,
  AdminRole,
  Feature,
  Quota,
  UsageMetric,
  FeatureSet,
  QuotaSet,
  PlanDefinition,
} from "./billing";

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
  "video_post",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const VIDEO_ASSET_KINDS: readonly AssetKind[] = ["video_post"];
export const IMAGE_ASSET_KINDS: readonly AssetKind[] = [
  "poster",
  "hero",
  "og",
  "email_header",
];

export function isVideoAssetKind(kind: AssetKind | string): boolean {
  return (VIDEO_ASSET_KINDS as readonly string[]).includes(kind);
}

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
  "instagram",
  "facebook",
  "email_hubspot",
  "email_mailchimp",
] as const;
export type Channel = (typeof CHANNELS)[number];

// --- LLM models (test-chat selector + manager registry) -------------------
// Catalog of models the manager can run sub-agents through. The web admin's
// /api/test-chat/models route filters this list by which provider keys are
// set; the manager looks up `provider` here to pick the right AI-SDK adapter.

export const LLM_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type LlmModelInfo = {
  id: string;
  label: string;
  provider: LlmProvider;
};

export const LLM_MODELS: readonly LlmModelInfo[] = [
  // Anthropic
  { id: "claude-opus-4-7",            label: "Opus 4.7",         provider: "anthropic" },
  { id: "claude-sonnet-4-6",          label: "Sonnet 4.6",       provider: "anthropic" },
  { id: "claude-sonnet-4-5",          label: "Sonnet 4.5",       provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001",  label: "Haiku 4.5",        provider: "anthropic" },
  // OpenAI — gpt-5 / o-series are reasoning models; the AI SDK strips
  // temperature/top_p automatically for ids starting with "gpt-5" or "o".
  { id: "gpt-5",                      label: "GPT-5",            provider: "openai" },
  { id: "gpt-5-mini",                 label: "GPT-5 mini",       provider: "openai" },
  { id: "gpt-5-nano",                 label: "GPT-5 nano",       provider: "openai" },
  { id: "o3",                         label: "o3",               provider: "openai" },
  { id: "o4-mini",                    label: "o4-mini",          provider: "openai" },
  { id: "gpt-4.1",                    label: "GPT-4.1",          provider: "openai" },
  { id: "gpt-4o",                     label: "GPT-4o",           provider: "openai" },
  { id: "gpt-4o-mini",                label: "GPT-4o mini",      provider: "openai" },
  { id: "o3-mini",                    label: "o3-mini",          provider: "openai" },
  // Google
  { id: "gemini-2.5-pro",             label: "Gemini 2.5 Pro",   provider: "google" },
  { id: "gemini-2.5-flash",           label: "Gemini 2.5 Flash", provider: "google" },
  { id: "gemini-2.5-flash-lite",      label: "Gemini 2.5 Flash Lite", provider: "google" },
  { id: "gemini-2.0-flash",           label: "Gemini 2.0 Flash", provider: "google" },
];

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
};

export type LlmModel = string;

export const DEFAULT_LLM_MODEL: LlmModel = "claude-sonnet-4-5";

export function getModelInfo(id: string): LlmModelInfo | undefined {
  return LLM_MODELS.find((m) => m.id === id);
}

export function resolveLlmModel(input: unknown): LlmModel {
  return typeof input === "string" && getModelInfo(input)
    ? input
    : DEFAULT_LLM_MODEL;
}

// --- Sub-agent kinds (per-agent model overrides) --------------------------
// Identifiers for the four LLM-driven sub-agents the orchestrator and
// workflows can route to. Used as keys in `settings.sub_agent_models` so an
// admin can pin (e.g.) the Strategist to Opus while everything else stays on
// Sonnet.

export const SUB_AGENT_KINDS = [
  "strategist",
  "content",
  "asset",
  "analyst",
  "researcher",
] as const;
export type SubAgentKind = (typeof SUB_AGENT_KINDS)[number];

export const SUB_AGENT_LABELS: Record<SubAgentKind, string> = {
  strategist: "Strategist",
  content: "Content",
  asset: "Asset",
  analyst: "Analyst",
  researcher: "Researcher",
};

export type SubAgentModelOverrides = Partial<Record<SubAgentKind, LlmModel>>;

// Filter to known sub-agent ids + valid LLM ids; drop the rest. Used by the
// settings PATCH route and helpers that read the row back.
export function resolveSubAgentModelOverrides(
  input: unknown,
): SubAgentModelOverrides {
  if (!input || typeof input !== "object") return {};
  const out: SubAgentModelOverrides = {};
  for (const kind of SUB_AGENT_KINDS) {
    const v = (input as Record<string, unknown>)[kind];
    if (typeof v === "string" && getModelInfo(v)) out[kind] = v;
  }
  return out;
}

// --- LLM pricing (USD per 1M tokens) ---------------------------------------
// List prices captured 2026-Q2. Update here whenever a provider changes
// rates; historical llm_usage rows aren't backfilled, so older costs
// remain calculated against the price that was in effect at write time.
//
// Models not present here record null cost — token counts are still useful.

export type LlmPrice = {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cached input tokens (Anthropic prompt caching). Optional. */
  cachedInput?: number;
};

export const LLM_PRICING: Record<string, LlmPrice> = {
  // Anthropic
  "claude-opus-4-7":            { input: 15,    output: 75,   cachedInput: 1.5 },
  "claude-sonnet-4-6":          { input: 3,     output: 15,   cachedInput: 0.3 },
  "claude-sonnet-4-5":          { input: 3,     output: 15,   cachedInput: 0.3 },
  "claude-haiku-4-5-20251001":  { input: 1,     output: 5,    cachedInput: 0.1 },
  // OpenAI
  "gpt-5":                      { input: 1.25,  output: 10 },
  "gpt-5-mini":                 { input: 0.25,  output: 2 },
  "gpt-5-nano":                 { input: 0.05,  output: 0.4 },
  "o3":                         { input: 2,     output: 8 },
  "o4-mini":                    { input: 1.1,   output: 4.4 },
  "gpt-4.1":                    { input: 2,     output: 8 },
  "gpt-4o":                     { input: 2.5,   output: 10 },
  "gpt-4o-mini":                { input: 0.15,  output: 0.6 },
  "o3-mini":                    { input: 1.1,   output: 4.4 },
  // Google
  "gemini-2.5-pro":             { input: 1.25,  output: 5 },
  "gemini-2.5-flash":           { input: 0.3,   output: 2.5 },
  "gemini-2.5-flash-lite":      { input: 0.1,   output: 0.4 },
  "gemini-2.0-flash":           { input: 0.1,   output: 0.4 },
};

export function computeLlmCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number | null {
  const p = LLM_PRICING[model];
  if (!p) return null;
  const cachedRate = p.cachedInput ?? p.input;
  const billableInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (billableInput / 1_000_000) * p.input +
    (cachedInputTokens / 1_000_000) * cachedRate +
    (outputTokens / 1_000_000) * p.output
  );
}

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
  | `discord:C${string}:T${string}`
  | `web:S${string}:T${string}`;

// --- Brand memory slugs ---------------------------------------------------
// The five documents previously edited as Markdown files in
// apps/manager/memory/brand/* and apps/manager/memory/product/*. Now stored
// in the `brand_memory` table; the file copies are bootstrap templates and
// the manager's read-side fallback if the DB is unreachable.

export const BRAND_MEMORY_SLUGS = [
  "brand.voice",
  "brand.icp",
  "brand.visual",
  "product.state",
  "product.positioning",
] as const;
export type BrandMemorySlug = (typeof BRAND_MEMORY_SLUGS)[number];

export const BRAND_MEMORY_TITLES: Record<BrandMemorySlug, string> = {
  "brand.voice": "Brand voice",
  "brand.icp": "Ideal customer profile",
  "brand.visual": "Visual guidelines",
  "product.state": "Product state",
  "product.positioning": "Product positioning",
};

// File paths used by the manager as a fallback when a DB row is missing
// (e.g. fresh install before the first admin save, or DB outage).
export const BRAND_MEMORY_FILE_PATHS: Record<BrandMemorySlug, string> = {
  "brand.voice": "brand/voice.md",
  "brand.icp": "brand/icp.md",
  "brand.visual": "brand/visual.md",
  "product.state": "product/state.md",
  "product.positioning": "product/positioning.md",
};

// --- Brand documents (corpus + extraction) --------------------------------
// Raw PDFs / DOCX / MD / TXT uploaded by admins. Parsed + chunked + embedded,
// then an LLM extractor distills them into draft brand_memory bodies that the
// human reviews and approves.

export const BRAND_DOC_STATUSES = [
  "uploaded",
  "parsing",
  "parsed",
  "embedding",
  "embedded",
  "failed",
  "removed",
] as const;
export type BrandDocStatus = (typeof BRAND_DOC_STATUSES)[number];

export const BRAND_DOC_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/plain",
] as const;
export type BrandDocMime = (typeof BRAND_DOC_MIME_TYPES)[number];

export const BRAND_DRAFT_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "superseded",
] as const;
export type BrandDraftStatus = (typeof BRAND_DRAFT_STATUSES)[number];

export const EXTRACTION_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
] as const;
export type ExtractionRunStatus = (typeof EXTRACTION_RUN_STATUSES)[number];

export type BrandDraftCitation = {
  /** brand_documents.id */
  docId: string;
  /** embeddings.chunk_index */
  chunkIndex: number;
  /** Short verbatim snippet (≤ 240 chars) from the source chunk. */
  snippet: string;
};

// --- Brand design system --------------------------------------------------
// Structured complement to the freeform "brand.visual" memory doc. Lives in
// the `brand_design_system` table; logos are stored in the `assets` Supabase
// bucket and referenced by storage path.

export const DESIGN_COLOR_ROLES = [
  "primary",
  "secondary",
  "accent",
  "neutral",
  "background",
  "text",
  "success",
  "warning",
  "danger",
] as const;
export type DesignColorRole = (typeof DESIGN_COLOR_ROLES)[number];

export const DESIGN_LOGO_VARIANTS = [
  "primary",
  "mark",
  "wordmark",
  "light",
  "dark",
  "monochrome",
] as const;
export type DesignLogoVariant = (typeof DESIGN_LOGO_VARIANTS)[number];

export type DesignColor = {
  name: string;
  hex: string;
  role?: DesignColorRole;
  usage?: string;
};

export type DesignTypography = {
  headingFamily?: string;
  bodyFamily?: string;
  monoFamily?: string;
  weights?: number[];
  notes?: string;
};

export type DesignLogo = {
  variant: DesignLogoVariant;
  storagePath: string;
  contentType?: string;
  notes?: string;
};

export type DesignTokens = {
  spacing?: string;
  radii?: string;
  shadows?: string;
  iconography?: string;
  notes?: string;
};

export type BrandDesignSystem = {
  colors: DesignColor[];
  typography: DesignTypography;
  logos: DesignLogo[];
  tokens: DesignTokens;
};

export const EMPTY_DESIGN_SYSTEM: BrandDesignSystem = {
  colors: [],
  typography: {},
  logos: [],
  tokens: {},
};

// --- Image generation models ----------------------------------------------

export type ImageProvider = "replicate" | "google" | "openai";

// Tells the dispatcher which input shape to build for the underlying API.
// `sdxl`          → width/height + negative_prompt + scheduler/steps/guidance.
// `nano-banana`   → aspect_ratio string + optional image_input array (Replicate).
// `flux`          → aspect_ratio string, no negative_prompt.
// `google-image`  → Gemini :generateContent endpoint (Nano Banana / Nano Banana 2).
// `openai-image`  → OpenAI /v1/images/generations endpoint (gpt-image-1).
export type ImageInputShape =
  | "sdxl"
  | "nano-banana"
  | "flux"
  | "google-image"
  | "openai-image";

export type ImageModelInfo = {
  id: string;
  label: string;
  description: string;
  provider: ImageProvider;
  /** Provider-specific model reference. For Replicate: "owner/name" or "owner/name:version". For Google: bare model id (e.g. "gemini-3-pro-image-preview"). */
  modelRef: string;
  inputShape: ImageInputShape;
  supportsNegativePrompt: boolean;
  supportsImageInput: boolean;
};

export const IMAGE_MODELS: readonly ImageModelInfo[] = [
  {
    // Note: id retained for backward compatibility (DEFAULT_IMAGE_MODEL,
    // existing Settings rows). The model behind this id is actually
    // "Nano Banana Pro" — the flagship slow/high-quality variant. The
    // separately-released "Nano Banana 2" is gemini-3.1-flash-image-preview
    // and is registered as `nano-banana-2-flash` below.
    id: "nano-banana-2",
    label: "Nano Banana Pro (Gemini 3 Pro Image)",
    description: "Google's flagship image model via the native Gemini API. 'Thinking' mode for complex compositions, best in-image text rendering, multi-image composition. Slower/pricier than the Flash variants. Uses GEMINI_API_KEY.",
    provider: "google",
    modelRef: "gemini-3-pro-image-preview",
    inputShape: "google-image",
    supportsNegativePrompt: false,
    supportsImageInput: true,
  },
  {
    id: "nano-banana-2-flash",
    label: "Nano Banana 2 (Gemini 3.1 Flash Image)",
    description: "Released Feb 2026. High-efficiency counterpart to Nano Banana Pro — 4K output, optimized for speed and high-volume use. Uses GEMINI_API_KEY.",
    provider: "google",
    modelRef: "gemini-3.1-flash-image-preview",
    inputShape: "google-image",
    supportsNegativePrompt: false,
    supportsImageInput: true,
  },
  {
    id: "nano-banana-native",
    label: "Nano Banana (Gemini 2.5 Flash Image)",
    description: "Original Nano Banana via the native Gemini API. Lower-latency legacy fast model. Uses GEMINI_API_KEY.",
    provider: "google",
    modelRef: "gemini-2.5-flash-image",
    inputShape: "google-image",
    supportsNegativePrompt: false,
    supportsImageInput: true,
  },
  {
    id: "nano-banana",
    label: "Nano Banana (Gemini 2.5 Flash Image, via Replicate)",
    description: "Replicate-hosted Nano Banana. Kept as fallback when GEMINI_API_KEY is not configured.",
    provider: "replicate",
    modelRef: "google/nano-banana",
    inputShape: "nano-banana",
    supportsNegativePrompt: false,
    supportsImageInput: true,
  },
  {
    id: "sdxl",
    label: "Stable Diffusion XL",
    description: "Photoreal/illustrative backgrounds. Supports negative prompts and pixel-precise dimensions.",
    provider: "replicate",
    modelRef: "stability-ai/sdxl:39ed52f2319f9bf9f645afe1b76c5c4ff4d2fc18a408ef4ea6b5f1c2c7a97f1e",
    inputShape: "sdxl",
    supportsNegativePrompt: true,
    supportsImageInput: false,
  },
  {
    id: "flux-schnell",
    label: "Flux Schnell (fast)",
    description: "Black Forest Labs' fast model. ~4-step inference, good general quality at low latency.",
    provider: "replicate",
    modelRef: "black-forest-labs/flux-schnell",
    inputShape: "flux",
    supportsNegativePrompt: false,
    supportsImageInput: false,
  },
  {
    id: "gpt-image-2",
    label: "GPT Image 2 (ChatGPT Images 2.0)",
    description: "OpenAI's flagship image model (released Apr 2026). Best legible in-image text on any provider, up to 4K output, any-resolution support. Slower + pricier than Gemini, but the right choice when the model itself must render headlines or marketing copy. Uses OPENAI_API_KEY.",
    provider: "openai",
    modelRef: "gpt-image-2",
    inputShape: "openai-image",
    supportsNegativePrompt: false,
    supportsImageInput: false,
  },
  {
    id: "gpt-image-1-5",
    label: "GPT Image 1.5",
    description: "Mid-tier OpenAI image model. Step between gpt-image-1 and gpt-image-2 on quality and price. Uses OPENAI_API_KEY.",
    provider: "openai",
    modelRef: "gpt-image-1.5",
    inputShape: "openai-image",
    supportsNegativePrompt: false,
    supportsImageInput: false,
  },
  {
    id: "gpt-image-1",
    label: "GPT Image 1 (legacy)",
    description: "OpenAI's first widely-available image model. Strong prompt adherence and good in-image text rendering. Kept for compatibility — gpt-image-2 is the newer/better choice. Uses OPENAI_API_KEY.",
    provider: "openai",
    modelRef: "gpt-image-1",
    inputShape: "openai-image",
    supportsNegativePrompt: false,
    supportsImageInput: false,
  },
  {
    id: "gpt-image-1-mini",
    label: "GPT Image 1 mini",
    description: "Cheap/fast OpenAI image variant. Lower fidelity than gpt-image-1 but cost-efficient for high-volume / draft use. Uses OPENAI_API_KEY.",
    provider: "openai",
    modelRef: "gpt-image-1-mini",
    inputShape: "openai-image",
    supportsNegativePrompt: false,
    supportsImageInput: false,
  },
];

export type ImageModel = string;

export const DEFAULT_IMAGE_MODEL: ImageModel = "nano-banana-2";

export function getImageModelInfo(id: string): ImageModelInfo | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

export function resolveImageModel(input: unknown): ImageModel {
  return typeof input === "string" && getImageModelInfo(input)
    ? input
    : DEFAULT_IMAGE_MODEL;
}

// --- Video generation models ----------------------------------------------

export type VideoProvider = "google";

// Veo 3.1 supports 16:9 (landscape) and 9:16 (portrait) only.
export type VideoAspect = "16:9" | "9:16";

export type VideoModelInfo = {
  id: string;
  label: string;
  description: string;
  provider: VideoProvider;
  /** Bare Gemini model id (e.g. "veo-3.1-generate-preview"). */
  modelRef: string;
  /** Default duration in seconds. Veo currently produces ~8s clips. */
  defaultDurationSec: number;
  supportsAudio: boolean;
  supportsImageToVideo: boolean;
};

export const VIDEO_MODELS: readonly VideoModelInfo[] = [
  {
    id: "veo-3.1",
    label: "Veo 3.1 (Google)",
    description: "Google's video model. ~8s 1080p clips with native audio. Supports text-to-video and image-to-video. Uses GEMINI_API_KEY.",
    provider: "google",
    modelRef: "veo-3.1-generate-preview",
    defaultDurationSec: 8,
    supportsAudio: true,
    supportsImageToVideo: true,
  },
  {
    id: "veo-3.1-fast",
    label: "Veo 3.1 Fast (Google)",
    description: "Lower-latency / lower-cost variant of Veo 3.1. ~8s clips.",
    provider: "google",
    modelRef: "veo-3.1-fast-generate-preview",
    defaultDurationSec: 8,
    supportsAudio: true,
    supportsImageToVideo: true,
  },
];

export type VideoModel = string;

export const DEFAULT_VIDEO_MODEL: VideoModel = "veo-3.1";

export function getVideoModelInfo(id: string): VideoModelInfo | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

export function resolveVideoModel(input: unknown): VideoModel {
  return typeof input === "string" && getVideoModelInfo(input)
    ? input
    : DEFAULT_VIDEO_MODEL;
}

// Channels that get a promotional video alongside the still image. Blog/email
// stay image-only. Mirrored in apps/web/lib/video-variant.ts; keep in sync.
export const VIDEO_ENABLED_CONTENT_TYPES: readonly ContentType[] = [
  "linkedin",
  "x_post",
  "x_thread",
];

export function contentTypeWantsVideo(type: ContentType | string): boolean {
  return (VIDEO_ENABLED_CONTENT_TYPES as readonly string[]).includes(type);
}

// --- Workflow engine ------------------------------------------------------
// The engine that runs all workflow starts. Set globally in Settings; the
// dispatcher and the manual creation form both read this value.

// Phase 4 cutover removed the "custom" engine (Manager-routed). Existing
// settings rows still carrying "custom" are coerced to the new default
// (vercel) by resolveWorkflowEngine.
export const WORKFLOW_ENGINES = ["vercel", "cloudflare"] as const;
export type WorkflowEngineId = (typeof WORKFLOW_ENGINES)[number];

export const DEFAULT_WORKFLOW_ENGINE: WorkflowEngineId = "vercel";

export function resolveWorkflowEngine(input: unknown): WorkflowEngineId {
  return typeof input === "string" &&
    (WORKFLOW_ENGINES as readonly string[]).includes(input)
    ? (input as WorkflowEngineId)
    : DEFAULT_WORKFLOW_ENGINE;
}

// --- Settings keys (typed) ------------------------------------------------

export type ChannelCaps = Partial<Record<Channel, number>>;

// Daily-research search providers. Both are external HTTP APIs gated by an
// env-supplied key. Toggle in Settings → Research.
export const RESEARCH_SEARCH_PROVIDERS = ["tavily", "brave"] as const;
export type ResearchSearchProvider = (typeof RESEARCH_SEARCH_PROVIDERS)[number];
export const DEFAULT_RESEARCH_SEARCH_PROVIDER: ResearchSearchProvider = "tavily";

export function resolveResearchSearchProvider(input: unknown): ResearchSearchProvider {
  return typeof input === "string" &&
    (RESEARCH_SEARCH_PROVIDERS as readonly string[]).includes(input)
    ? (input as ResearchSearchProvider)
    : DEFAULT_RESEARCH_SEARCH_PROVIDER;
}

// --- Embedding providers --------------------------------------------------
// Provider-agnostic embedding contract. The `embeddings.embedding` column is
// fixed at 1536 dims (see packages/db schema), so only providers/models that
// can output 1536 dims are wired today. Voyage's natural dim is 1024 — it
// stays in the catalog as a `wired: false` placeholder until the schema is
// generalized to hold a per-row dim.
//
// Read by packages/agents/src/kb/embed-client.ts at call time; the resolved
// model id is also written into `embeddings.model` so the read side can
// filter to vectors produced by the *current* provider (different geometry
// across providers => garbage similarity if mixed).

export const EMBEDDING_PROVIDERS = ["gemini", "openai", "voyage"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

export type EmbeddingModelInfo = {
  id: string;
  label: string;
  provider: EmbeddingProvider;
  /** Native output dimensions before any reduction. */
  nativeDims: number;
  /** Whether the provider can deliver 1536 dims (native or reduced). */
  fits1536: boolean;
  /** False = catalogued for the UI but not implemented in embed-client yet. */
  wired: boolean;
};

export const EMBEDDING_MODELS: readonly EmbeddingModelInfo[] = [
  {
    id: "gemini-embedding-001",
    label: "Gemini Embedding 001 (1536d, reduced)",
    provider: "gemini",
    nativeDims: 3072,
    fits1536: true,
    wired: true,
  },
  {
    id: "text-embedding-3-small",
    label: "OpenAI text-embedding-3-small (1536d)",
    provider: "openai",
    nativeDims: 1536,
    fits1536: true,
    wired: true,
  },
  {
    id: "text-embedding-3-large",
    label: "OpenAI text-embedding-3-large (1536d, reduced)",
    provider: "openai",
    nativeDims: 3072,
    fits1536: true,
    wired: true,
  },
  {
    id: "voyage-3-large",
    label: "Voyage 3 Large (1024d — needs DB migration)",
    provider: "voyage",
    nativeDims: 1024,
    fits1536: false,
    wired: false,
  },
];

export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProvider = "gemini";
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

export const EMBEDDING_PROVIDER_LABELS: Record<EmbeddingProvider, string> = {
  gemini: "Google Gemini",
  openai: "OpenAI",
  voyage: "Voyage AI",
};

export type EmbeddingConfig = {
  provider: EmbeddingProvider;
  model: string;
};

export function resolveEmbeddingConfig(input: {
  provider?: unknown;
  model?: unknown;
}): EmbeddingConfig {
  const provider =
    typeof input.provider === "string" &&
    (EMBEDDING_PROVIDERS as readonly string[]).includes(input.provider)
      ? (input.provider as EmbeddingProvider)
      : DEFAULT_EMBEDDING_PROVIDER;

  const candidate =
    typeof input.model === "string"
      ? EMBEDDING_MODELS.find((m) => m.id === input.model)
      : undefined;

  const model =
    candidate && candidate.provider === provider && candidate.fits1536
      ? candidate.id
      : (EMBEDDING_MODELS.find((m) => m.provider === provider && m.fits1536)?.id ??
        DEFAULT_EMBEDDING_MODEL);

  return { provider, model };
}

export type SettingsShape = {
  kill_switch: boolean;
  channel_caps: ChannelCaps;
  approval_policy: { mode: "single" | "two_approver"; channels?: Channel[] };
  image_model: ImageModel;
  video_model: VideoModel;
  /** Master toggle for promotional video generation on submit. */
  video_generation_enabled: boolean;
  /** Engine that runs every workflow start. Picked once globally. */
  workflow_engine: WorkflowEngineId;
  /**
   * Default LLM for the orchestrator and any workflow start that doesn't
   * specify a per-run `model`. Sub-agents fall back to this when no
   * per-agent override is set in `sub_agent_models`.
   */
  workflow_model: LlmModel;
  /**
   * Per-sub-agent LLM overrides. Each kind that has an entry uses that
   * model; missing kinds inherit `workflow_model`.
   */
  sub_agent_models: SubAgentModelOverrides;
  /**
   * Model used by the brand-extract pipeline (Brand → Generate). Falls back
   * to `workflow_model` when unset. Must be a multimodal model that can
   * read PDF file parts (Anthropic Claude or Google Gemini today).
   */
  brand_extract_model: LlmModel;
  /**
   * Keywords scanned by the daily research cron. Each keyword produces one
   * Researcher run + one KB finding. Empty list disables the cron.
   */
  research_keywords: string[];
  /** Which external search API the Researcher uses for the daily scan. */
  research_search_provider: ResearchSearchProvider;
  /**
   * Provider used to embed text for the KB + similarity tools. Different
   * providers produce vectors of different geometries — the read side
   * filters `embeddings.model` to the active model so old vectors don't
   * pollute search results until they're re-embedded.
   */
  embedding_provider: EmbeddingProvider;
  /** Embedding model id within the chosen provider. */
  embedding_model: string;
};
