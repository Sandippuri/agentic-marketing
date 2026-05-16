"use client";

import { useMemo, useState, useTransition } from "react";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_RESEARCH_SEARCH_PROVIDER,
  DEFAULT_USER_ALLOWED_MODELS,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_WORKFLOW_ENGINE,
  EMBEDDING_MODELS,
  EMBEDDING_PROVIDERS,
  EMBEDDING_PROVIDER_LABELS,
  IMAGE_MODELS,
  LLM_MODELS,
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  RESEARCH_SEARCH_PROVIDERS,
  SUB_AGENT_KINDS,
  SUB_AGENT_LABELS,
  VIDEO_MODELS,
  type EmbeddingProvider,
  type ImageModel,
  type LlmModel,
  type LlmProvider,
  type ResearchSearchProvider,
  type SettingsShape,
  type SubAgentKind,
  type SubAgentModelOverrides,
  type VideoModel,
  type WorkflowEngineId,
} from "@marketing/shared-types";
import type { EngineDescriptor } from "@/lib/workflow-engines";

type Props = {
  initialSettings: Partial<SettingsShape>;
  engines: EngineDescriptor[];
  providerAvailability: Record<LlmProvider, boolean>;
};

// `sub_agent_models` accepts `null` per kind to clear that override on the
// server; everything else mirrors SettingsShape directly.
type PatchBody = Omit<Partial<SettingsShape>, "sub_agent_models"> & {
  sub_agent_models?: Partial<Record<SubAgentKind, LlmModel | null>>;
};

const RESEARCH_PROVIDER_LABELS: Record<ResearchSearchProvider, string> = {
  tavily: "Tavily",
  brave: "Brave Search",
};

const RESEARCH_PROVIDER_HINTS: Record<ResearchSearchProvider, string> = {
  tavily:
    "LLM-tuned search. Returns answers + extracted page content. Requires TAVILY_API_KEY.",
  brave:
    "Independent web index. Returns ranked links + snippets. Requires BRAVE_SEARCH_API_KEY.",
};

const EMBEDDING_PROVIDER_HINTS: Record<EmbeddingProvider, string> = {
  gemini:
    "Google Gemini Embedding 001, reduced to 1536d. Free tier covers most workloads. Requires GEMINI_API_KEY.",
  openai:
    "OpenAI text-embedding-3 family, native 1536d (or reduced from 3072). Requires OPENAI_API_KEY + active billing.",
  voyage:
    "Voyage AI — catalogued for the future. The DB column needs a 1024d migration before Voyage can be selected.",
};

async function patchSettings(body: PatchBody) {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `PATCH /api/settings → ${res.status}`);
  }
  return res.json() as Promise<Partial<SettingsShape>>;
}

export function ModelsForm({
  initialSettings,
  engines,
  providerAvailability,
}: Props) {
  const [settings, setSettings] = useState<Partial<SettingsShape>>(initialSettings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function update(body: PatchBody) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings(body);
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  const imageModel: ImageModel = settings.image_model ?? DEFAULT_IMAGE_MODEL;
  const videoModel: VideoModel = settings.video_model ?? DEFAULT_VIDEO_MODEL;
  const videoEnabled = settings.video_generation_enabled ?? false;
  const workflowEngine: WorkflowEngineId =
    settings.workflow_engine ?? DEFAULT_WORKFLOW_ENGINE;
  const workflowModel: LlmModel = settings.workflow_model ?? DEFAULT_LLM_MODEL;
  const subAgentModels: SubAgentModelOverrides = settings.sub_agent_models ?? {};
  const brandExtractModel: LlmModel =
    settings.brand_extract_model ?? workflowModel;
  const researchProvider: ResearchSearchProvider =
    settings.research_search_provider ?? DEFAULT_RESEARCH_SEARCH_PROVIDER;
  const embeddingProvider: EmbeddingProvider =
    (settings.embedding_provider as EmbeddingProvider | undefined) ??
    DEFAULT_EMBEDDING_PROVIDER;
  const embeddingModel: string =
    settings.embedding_model ??
    (EMBEDDING_MODELS.find(
      (m) => m.provider === embeddingProvider && m.fits1536,
    )?.id ?? DEFAULT_EMBEDDING_MODEL);
  const embeddingModelsForProvider = EMBEDDING_MODELS.filter(
    (m) => m.provider === embeddingProvider,
  );

  const allowedModels: string[] = useMemo(() => {
    const v = settings.user_allowed_models;
    return Array.isArray(v) && v.length > 0
      ? v
      : [...DEFAULT_USER_ALLOWED_MODELS];
  }, [settings.user_allowed_models]);
  const allowedSet = new Set(allowedModels);

  function toggleAllowedModel(id: string) {
    const next = allowedSet.has(id)
      ? allowedModels.filter((x) => x !== id)
      : [...allowedModels, id];
    if (next.length === 0) {
      setError("At least one model must remain in the allowlist.");
      return;
    }
    update({ user_allowed_models: next });
  }

  function setEmbeddingProviderAndModel(id: EmbeddingProvider) {
    if (id === embeddingProvider) return;
    const fallback = EMBEDDING_MODELS.find(
      (m) => m.provider === id && m.fits1536,
    )?.id;
    if (!fallback) {
      setError(
        `No wired embedding model for provider "${id}". Pick another provider.`,
      );
      return;
    }
    update({ embedding_provider: id, embedding_model: fallback });
  }

  const imageModelInfo =
    IMAGE_MODELS.find((m) => m.id === imageModel) ??
    IMAGE_MODELS.find((m) => m.id === DEFAULT_IMAGE_MODEL);

  return (
    <div className="space-y-6">
      <Section
        title="Image generation"
        description="Used by the asset sub-agent and the per-content variant generator. Applies to new generations only — already-rendered assets are not re-created."
      >
        <div className="grid gap-2.5 md:grid-cols-2">
          {IMAGE_MODELS.map((m) => {
            const selected = m.id === imageModel;
            return (
              <button
                key={m.id}
                onClick={() => update({ image_model: m.id })}
                disabled={isPending || selected}
                className={[
                  "h-full text-left surface-2 px-4 py-3 transition-colors",
                  selected
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                    : "hover:border-[var(--border-strong)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-ink">{m.label}</span>
                  {selected && (
                    <span className="badge badge-success badge-dot">active</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-mid line-clamp-2">{m.description}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-mid">
                  <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5">
                    {m.provider}
                  </span>
                  {m.supportsNegativePrompt && (
                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5">
                      negative prompt
                    </span>
                  )}
                  {m.supportsImageInput && (
                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5">
                      image input
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        {imageModelInfo?.provider === "replicate" && (
          <p className="mt-3 text-xs text-mid">
            Requires{" "}
            <code className="rounded bg-[var(--bg-elevated)] px-1">
              REPLICATE_API_TOKEN
            </code>{" "}
            in env.
          </p>
        )}
      </Section>

      <Section
        title="Video generation"
        description="Promo clips alongside the still image for LinkedIn / X / X threads. Requires GEMINI_API_KEY. The toggle below pauses video generation platform-wide without losing the model pick."
        actions={
          <label className="inline-flex items-center gap-2 text-sm text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={videoEnabled}
              disabled={isPending}
              onChange={(e) =>
                update({ video_generation_enabled: e.target.checked })
              }
            />
            Video generation enabled
          </label>
        }
      >
        <div className="grid gap-2.5 md:grid-cols-2">
          {VIDEO_MODELS.map((m) => {
            const selected = m.id === videoModel;
            return (
              <button
                key={m.id}
                onClick={() => update({ video_model: m.id })}
                disabled={isPending || selected}
                className={[
                  "h-full text-left surface-2 px-4 py-3 transition-colors",
                  selected
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                    : "hover:border-[var(--border-strong)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-ink">{m.label}</span>
                  {selected && (
                    <span className="badge badge-success badge-dot">active</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-mid line-clamp-2">
                  {m.description}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-mid">
                  <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5">
                    {m.provider}
                  </span>
                  <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5">
                    {m.defaultDurationSec}s clips
                  </span>
                  {m.supportsAudio && (
                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5">
                      audio
                    </span>
                  )}
                  {m.supportsImageToVideo && (
                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5">
                      image-to-video
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="Workflow engine"
        description="Runtime that executes every workflow start (campaign plan, single post, asset). Applies to all new runs."
      >
        <div className="grid gap-2.5 md:grid-cols-2">
          {engines.map((e) => {
            const selected = e.id === workflowEngine;
            const disabled = !e.available;
            return (
              <button
                key={e.id}
                onClick={() => update({ workflow_engine: e.id })}
                disabled={isPending || selected || disabled}
                className={[
                  "h-full text-left surface-2 px-4 py-3 transition-colors",
                  selected
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                    : disabled
                      ? "opacity-60 cursor-not-allowed"
                      : "hover:border-[var(--border-strong)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-ink">{e.label}</span>
                  {selected ? (
                    <span className="badge badge-success badge-dot">active</span>
                  ) : !e.available ? (
                    <span className="badge badge-neutral">soon</span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-mid line-clamp-2">{e.description}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-mid">
                  {e.kinds.map((k) => (
                    <span
                      key={k}
                      className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5"
                    >
                      {k}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="Workflow LLM"
        description="Default model for the orchestrator and every workflow run. Sub-agents inherit this unless overridden below. Models from providers without an API key are disabled."
      >
        {LLM_PROVIDERS.map((provider) => {
          const models = LLM_MODELS.filter((m) => m.provider === provider);
          if (models.length === 0) return null;
          const providerOk = providerAvailability[provider];
          return (
            <div key={provider} className="mb-4 last:mb-0">
              <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-mid">
                <span>{PROVIDER_LABELS[provider]}</span>
                {!providerOk && (
                  <span className="badge badge-neutral">no API key</span>
                )}
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {models.map((m) => {
                  const selected = m.id === workflowModel;
                  return (
                    <button
                      key={m.id}
                      onClick={() => update({ workflow_model: m.id })}
                      disabled={isPending || selected || !providerOk}
                      className={[
                        "h-full text-left surface-2 px-3 py-2.5 transition-colors",
                        selected
                          ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                          : !providerOk
                            ? "opacity-60 cursor-not-allowed"
                            : "hover:border-[var(--border-strong)]",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink truncate">
                          {m.label}
                        </span>
                        {selected && (
                          <span className="badge badge-success badge-dot shrink-0">
                            active
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-mid truncate">
                        {m.id}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className="mt-5 pt-5 border-t border-[var(--border)]">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-ink">Brand extraction model</h3>
            <p className="mt-0.5 text-xs text-mid">
              Used by Brand → Generate to read uploaded source docs and draft
              brand-memory + design tokens. Must be a multimodal model that can
              read PDFs (Anthropic Claude or Google Gemini).
            </p>
          </div>
          <select
            value={brandExtractModel}
            disabled={isPending}
            onChange={(e) =>
              update({ brand_extract_model: e.target.value as LlmModel })
            }
            className="field field-sm w-full max-w-md"
          >
            {LLM_PROVIDERS.map((provider) => {
              const providerOk = providerAvailability[provider];
              const models = LLM_MODELS.filter(
                (m) => m.provider === provider && provider !== "openai",
              );
              if (models.length === 0) return null;
              return (
                <optgroup
                  key={provider}
                  label={
                    providerOk
                      ? PROVIDER_LABELS[provider]
                      : `${PROVIDER_LABELS[provider]} (no API key)`
                  }
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id} disabled={!providerOk}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>
      </Section>

      <Section
        title="Sub-agent overrides"
        description='Pin a specific sub-agent to a different model. Leave on "Workflow default" to inherit the Workflow LLM. Per-call model overrides (e.g. from /workflow chat commands) still win.'
      >
        <div className="grid gap-2.5 md:grid-cols-2">
          {SUB_AGENT_KINDS.map((kind) => {
            const current = subAgentModels[kind] ?? "";
            return (
              <div key={kind} className="surface-2 px-4 py-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-medium text-ink">
                    {SUB_AGENT_LABELS[kind]}
                  </div>
                  {current ? (
                    <span className="badge badge-success badge-dot shrink-0">
                      pinned
                    </span>
                  ) : (
                    <span className="badge badge-neutral shrink-0">inherits</span>
                  )}
                </div>
                <select
                  value={current}
                  disabled={isPending}
                  onChange={(e) => {
                    const v = e.target.value;
                    update({
                      sub_agent_models: {
                        [kind]: v === "" ? null : (v as LlmModel),
                      },
                    });
                  }}
                  className="field field-sm w-full"
                >
                  <option value="">Workflow default ({workflowModel})</option>
                  {LLM_PROVIDERS.map((provider) => {
                    const providerOk = providerAvailability[provider];
                    const models = LLM_MODELS.filter(
                      (m) => m.provider === provider,
                    );
                    if (models.length === 0) return null;
                    return (
                      <optgroup
                        key={provider}
                        label={
                          providerOk
                            ? PROVIDER_LABELS[provider]
                            : `${PROVIDER_LABELS[provider]} (no API key)`
                        }
                      >
                        {models.map((m) => (
                          <option
                            key={m.id}
                            value={m.id}
                            disabled={!providerOk}
                          >
                            {m.label}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title="Research search provider"
        description="External search API the daily Researcher cron hits to discover fresh URLs. Both have free tiers; pick whichever has a key configured."
      >
        <div className="grid gap-2.5 md:grid-cols-2">
          {RESEARCH_SEARCH_PROVIDERS.map((p) => {
            const selected = p === researchProvider;
            return (
              <button
                key={p}
                type="button"
                onClick={() => update({ research_search_provider: p })}
                disabled={isPending || selected}
                className={[
                  "h-full text-left surface-2 px-4 py-3 transition-colors",
                  selected
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                    : "hover:border-[var(--border-strong)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-ink">
                    {RESEARCH_PROVIDER_LABELS[p]}
                  </span>
                  {selected && (
                    <span className="badge badge-success badge-dot">active</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-mid">
                  {RESEARCH_PROVIDER_HINTS[p]}
                </p>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="Embedding provider"
        description="Powers the Knowledge Base, similar-content lookups, and common-mistake retrieval. Vectors stay 1536d across providers. Switching providers makes existing vectors invisible to search until you re-embed via the backfill route."
      >
        <div className="grid gap-2.5 md:grid-cols-3">
          {EMBEDDING_PROVIDERS.map((p) => {
            const selected = p === embeddingProvider;
            const wired = EMBEDDING_MODELS.some(
              (m) => m.provider === p && m.wired,
            );
            return (
              <button
                key={p}
                type="button"
                onClick={() => setEmbeddingProviderAndModel(p)}
                disabled={isPending || selected || !wired}
                className={[
                  "h-full text-left surface-2 px-4 py-3 transition-colors",
                  selected
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                    : "hover:border-[var(--border-strong)]",
                  !wired && "opacity-50 cursor-not-allowed",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title={
                  !wired
                    ? "Catalogued for the future. Needs a DB migration before it can be selected."
                    : undefined
                }
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-ink">
                    {EMBEDDING_PROVIDER_LABELS[p]}
                  </span>
                  {selected && (
                    <span className="badge badge-success badge-dot">active</span>
                  )}
                  {!wired && <span className="badge badge-muted">soon</span>}
                </div>
                <p className="mt-1 text-xs text-mid">
                  {EMBEDDING_PROVIDER_HINTS[p]}
                </p>
              </button>
            );
          })}
        </div>

        {embeddingModelsForProvider.length > 1 && (
          <div className="mt-4">
            <label className="block text-sm font-medium text-ink mb-1.5">
              Model
            </label>
            <select
              value={embeddingModel}
              onChange={(e) => update({ embedding_model: e.target.value })}
              disabled={isPending}
              className="field field-sm w-full"
            >
              {embeddingModelsForProvider.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.fits1536}>
                  {m.label}
                  {!m.fits1536 ? " — needs schema migration" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <p className="mt-3 text-xs text-mid">
          Re-embed existing rows after switching:{" "}
          <code className="text-ink">POST /api/admin/embeddings/backfill</code>
        </p>
      </Section>

      <Section
        title="User-facing model allowlist"
        description="Workspace users picking a model in chat / workflow see only these IDs. The platform-wide default lives in shared-types; the list below overrides it. Provider keys still gate availability."
      >
        {LLM_PROVIDERS.map((provider) => {
          const models = LLM_MODELS.filter((m) => m.provider === provider);
          if (models.length === 0) return null;
          const providerOk = providerAvailability[provider];
          return (
            <div key={provider} className="mb-4 last:mb-0">
              <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-mid">
                <span>{PROVIDER_LABELS[provider]}</span>
                {!providerOk && (
                  <span className="badge badge-neutral">no API key</span>
                )}
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {models.map((m) => {
                  const on = allowedSet.has(m.id);
                  return (
                    <label
                      key={m.id}
                      className={[
                        "flex items-start gap-2 surface-2 px-3 py-2.5 cursor-pointer transition-colors",
                        on
                          ? "border-[var(--accent)]"
                          : "hover:border-[var(--border-strong)]",
                      ].join(" ")}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={isPending}
                        onChange={() => toggleAllowedModel(m.id)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-ink truncate">
                          {m.label}
                        </span>
                        <span className="mt-0.5 block font-mono text-[11px] text-mid truncate">
                          {m.id}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </Section>

      {error && (
        <p className="text-sm text-[var(--danger)]">Error: {error}</p>
      )}
      {saved && !error && (
        <p className="text-sm text-[var(--success)] inline-flex items-center gap-1">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Saved.
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="surface p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-sm text-mid">{description}</p>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
