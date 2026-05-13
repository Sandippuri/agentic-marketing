"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_RESEARCH_SEARCH_PROVIDER,
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
  type Channel,
  type EmbeddingProvider,
  type ImageModel,
  type LlmModel,
  type LlmProvider,
  type ResearchSearchProvider,
  type SettingsShape,
  type SubAgentKind,
  type SubAgentModelOverrides,
  type WorkflowEngineId,
} from "@marketing/shared-types";
import type { EngineDescriptor } from "@/lib/workflow-engines";

const CHANNELS: Channel[] = [
  "internal_blog",
  "linkedin",
  "x",
  "email_hubspot",
  "email_mailchimp",
];

const CHANNEL_LABELS: Record<Channel, string> = {
  internal_blog: "Internal blog",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
  email_hubspot: "Email (HubSpot)",
  email_mailchimp: "Email (Mailchimp)",
};

type TabKey = "publishing" | "models" | "research" | "usage";

const RESEARCH_PROVIDER_LABELS: Record<ResearchSearchProvider, string> = {
  tavily: "Tavily",
  brave: "Brave Search",
};

const RESEARCH_PROVIDER_HINTS: Record<ResearchSearchProvider, string> = {
  tavily: "LLM-tuned search. Returns answers + extracted page content. Requires TAVILY_API_KEY.",
  brave: "Independent web index. Returns ranked links + snippets. Requires BRAVE_SEARCH_API_KEY.",
};
type ModelsTabKey = "image" | "engine" | "workflow" | "overrides";

type Props = {
  initialSettings: Partial<SettingsShape>;
  engines: EngineDescriptor[];
  /**
   * Which providers have an API key configured server-side. Models from
   * providers without a key render disabled in the picker so the user can
   * still see what's available, but can't pin a model that won't run.
   */
  providerAvailability: Record<LlmProvider, boolean>;
  usagePanel?: ReactNode;
};

// `sub_agent_models` accepts `null` per kind to clear that override on the
// server — the rest of the patch shape mirrors SettingsShape.
type PatchBody = Omit<Partial<SettingsShape>, "sub_agent_models"> & {
  sub_agent_models?: Partial<Record<SubAgentKind, LlmModel | null>>;
  research_keywords?: string[];
  research_search_provider?: ResearchSearchProvider;
  embedding_provider?: EmbeddingProvider;
  embedding_model?: string;
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
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `PATCH /api/settings → ${res.status}`);
  }
  return res.json() as Promise<Partial<SettingsShape>>;
}

export function SettingsForm({
  initialSettings,
  engines,
  providerAvailability,
  usagePanel,
}: Props) {
  const [settings, setSettings] = useState<Partial<SettingsShape>>(initialSettings);
  const [caps, setCaps] = useState<Partial<Record<Channel, string>>>(
    Object.fromEntries(
      CHANNELS.map((ch) => [ch, String(initialSettings.channel_caps?.[ch] ?? "")]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [active, setActive] = useState<TabKey>("publishing");
  const [modelsTab, setModelsTab] = useState<ModelsTabKey>("image");

  const killSwitch = settings.kill_switch ?? false;

  async function toggleKillSwitch() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({ kill_switch: !killSwitch });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  async function saveCaps() {
    setError(null);
    setSaved(false);
    const channel_caps: Partial<Record<Channel, number>> = {};
    for (const ch of CHANNELS) {
      const v = Number(caps[ch]);
      if (!Number.isNaN(v) && caps[ch] !== "") channel_caps[ch] = v;
    }
    startTransition(async () => {
      try {
        const next = await patchSettings({ channel_caps });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  async function setApprovalMode(mode: "single" | "two_approver") {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({ approval_policy: { mode } });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  const approvalMode = settings.approval_policy?.mode ?? "single";
  const imageModel: ImageModel = settings.image_model ?? DEFAULT_IMAGE_MODEL;
  const imageModelInfo =
    IMAGE_MODELS.find((m) => m.id === imageModel) ??
    IMAGE_MODELS.find((m) => m.id === DEFAULT_IMAGE_MODEL);

  async function setImageModel(id: ImageModel) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({ image_model: id });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  const workflowEngine: WorkflowEngineId =
    settings.workflow_engine ?? DEFAULT_WORKFLOW_ENGINE;

  async function setWorkflowEngine(id: WorkflowEngineId) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({ workflow_engine: id });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  const workflowModel: LlmModel = settings.workflow_model ?? DEFAULT_LLM_MODEL;
  const subAgentModels: SubAgentModelOverrides = settings.sub_agent_models ?? {};
  const brandExtractModel: LlmModel =
    settings.brand_extract_model ?? workflowModel;

  async function setWorkflowModel(id: LlmModel) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({ workflow_model: id });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  async function setBrandExtractModel(id: LlmModel) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({ brand_extract_model: id });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  const researchKeywords: string[] = Array.isArray(settings.research_keywords)
    ? settings.research_keywords
    : [];
  const researchProvider: ResearchSearchProvider =
    settings.research_search_provider ?? DEFAULT_RESEARCH_SEARCH_PROVIDER;
  const [keywordDraft, setKeywordDraft] = useState("");

  async function saveResearchKeywords(next: string[]) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const updated = await patchSettings({ research_keywords: next });
        setSettings((s) => ({ ...s, ...updated }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  async function addKeyword() {
    const trimmed = keywordDraft.trim();
    if (!trimmed) return;
    if (researchKeywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) {
      setKeywordDraft("");
      return;
    }
    const next = [...researchKeywords, trimmed].slice(0, 50);
    setKeywordDraft("");
    await saveResearchKeywords(next);
  }

  async function removeKeyword(kw: string) {
    const next = researchKeywords.filter((k) => k !== kw);
    await saveResearchKeywords(next);
  }

  async function setResearchProvider(id: ResearchSearchProvider) {
    if (id === researchProvider) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({ research_search_provider: id });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

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

  async function setEmbeddingProvider(id: EmbeddingProvider) {
    if (id === embeddingProvider) return;
    const fallback =
      EMBEDDING_MODELS.find((m) => m.provider === id && m.fits1536)?.id;
    if (!fallback) {
      setError(
        `No wired embedding model for provider "${id}". Pick another provider.`,
      );
      return;
    }
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({
          embedding_provider: id,
          embedding_model: fallback,
        });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  async function setEmbeddingModel(modelId: string) {
    if (modelId === embeddingModel) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({ embedding_model: modelId });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  // Sending null clears the override on the server (route.ts merges into
  // the existing row). Sending a model id pins that kind. The undefined
  // branch in the body type is just so TS is happy with the patch shape.
  async function setSubAgentModel(kind: SubAgentKind, id: LlmModel | null) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const next = await patchSettings({
          sub_agent_models: { [kind]: id },
        });
        setSettings((s) => ({ ...s, ...next }));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  const tabs: { key: TabKey; label: string; available: boolean }[] = [
    { key: "publishing", label: "Publishing", available: true },
    { key: "models", label: "Models", available: true },
    { key: "research", label: "Research", available: true },
    { key: "usage", label: "Usage", available: !!usagePanel },
  ];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex items-center gap-1 border-b border-[var(--border)] mb-5"
      >
        {tabs.map((tab) => {
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls={`settings-tabpanel-${tab.key}`}
              id={`settings-tab-${tab.key}`}
              disabled={!tab.available}
              onClick={() => tab.available && setActive(tab.key)}
              className={[
                "relative px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2",
                isActive
                  ? "text-ink border-[var(--accent)]"
                  : "text-mid border-transparent hover:text-ink",
                !tab.available && "opacity-40 cursor-not-allowed",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="settings-tabpanel-publishing"
        aria-labelledby="settings-tab-publishing"
        hidden={active !== "publishing"}
        className="space-y-5"
      >
        <section
          className="surface p-5"
          style={
            killSwitch
              ? { borderColor: "var(--danger)", background: "var(--danger-soft)" }
              : undefined
          }
        >
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-base font-semibold text-ink">
                  Publishing kill switch
                </h2>
                {killSwitch && (
                  <span className="badge badge-danger badge-dot">active</span>
                )}
              </div>
              <p className="text-sm text-mid">
                When active, the Distributor stops picking up new jobs and cancels
                all in-flight queued jobs.
              </p>
            </div>
            <button
              onClick={toggleKillSwitch}
              disabled={isPending}
              className={
                killSwitch ? "btn btn-secondary shrink-0" : "btn btn-danger shrink-0"
              }
              style={
                killSwitch
                  ? undefined
                  : {
                      background: "var(--danger)",
                      color: "white",
                      borderColor: "var(--danger)",
                    }
              }
            >
              {killSwitch ? "Disable kill switch" : "Enable kill switch"}
            </button>
          </div>
          {killSwitch && (
            <p className="mt-3 text-sm font-medium text-[var(--danger)]">
              Publishing is paused. No new content will be distributed.
            </p>
          )}
        </section>

        <section className="surface p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-ink">Daily channel caps</h2>
            <p className="mt-0.5 text-sm text-mid">
              Maximum posts per channel per day. Leave blank for no limit.
            </p>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {CHANNELS.map((ch) => (
              <div
                key={ch}
                className="flex items-center justify-between gap-3 surface-2 px-3 py-2"
              >
                <label className="text-sm text-ink">{CHANNEL_LABELS[ch]}</label>
                <input
                  type="number"
                  min={0}
                  value={caps[ch] ?? ""}
                  onChange={(e) => setCaps((c) => ({ ...c, [ch]: e.target.value }))}
                  placeholder="∞"
                  className="field field-sm w-20 text-center"
                />
              </div>
            ))}
          </div>
          <button
            onClick={saveCaps}
            disabled={isPending}
            className="mt-4 btn btn-primary btn-sm"
          >
            Save caps
          </button>
        </section>

        <section className="surface p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-ink">Approval policy</h2>
            <p className="mt-0.5 text-sm text-mid">
              Single-approver publishes on one approval. Two-approver requires two
              distinct team members.
            </p>
          </div>
          <div className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
            {(["single", "two_approver"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setApprovalMode(mode)}
                disabled={isPending}
                className={[
                  "px-3 py-1.5 text-[13px] rounded transition-colors",
                  approvalMode === mode
                    ? "bg-[var(--bg-elevated)] text-ink shadow-sm"
                    : "text-mid hover:text-ink",
                ].join(" ")}
              >
                {mode === "single" ? "Single approver" : "Two approvers"}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div
        role="tabpanel"
        id="settings-tabpanel-models"
        aria-labelledby="settings-tab-models"
        hidden={active !== "models"}
      >
        {(() => {
          const modelsTabs: { key: ModelsTabKey; label: string; summary: string }[] = [
            {
              key: "image",
              label: "Image",
              summary:
                imageModelInfo?.label ?? "—",
            },
            {
              key: "engine",
              label: "Engine",
              summary:
                engines.find((e) => e.id === workflowEngine)?.label ?? workflowEngine,
            },
            {
              key: "workflow",
              label: "Workflow LLM",
              summary:
                LLM_MODELS.find((m) => m.id === workflowModel)?.label ?? workflowModel,
            },
            {
              key: "overrides",
              label: "Sub-agent overrides",
              summary: (() => {
                const count = SUB_AGENT_KINDS.filter((k) => subAgentModels[k]).length;
                return count === 0 ? "All inherit" : `${count} pinned`;
              })(),
            },
          ];
          return (
            <div
              role="tablist"
              aria-label="Model settings"
              className="flex flex-wrap items-center gap-1.5 mb-4"
            >
              {modelsTabs.map((t) => {
                const isActive = modelsTab === t.key;
                return (
                  <button
                    key={t.key}
                    role="tab"
                    type="button"
                    aria-selected={isActive}
                    onClick={() => setModelsTab(t.key)}
                    className={[
                      "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] transition-colors",
                      isActive
                        ? "border-[var(--accent)] bg-[var(--surface-2)] text-ink"
                        : "border-[var(--border)] text-mid hover:text-ink hover:border-[var(--border-strong)]",
                    ].join(" ")}
                  >
                    <span className="font-medium">{t.label}</span>
                    <span className="text-[11px] text-mid truncate max-w-[180px]">
                      {t.summary}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })()}

        {modelsTab === "image" && (
          <section className="surface p-5">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-ink">Image generation model</h2>
              <p className="mt-0.5 text-sm text-mid">
                Used by the asset sub-agent and the per-content variant generator.
                Applies to new generations only — already-rendered assets are not
                re-created.
              </p>
            </div>
            <div className="grid gap-2.5 md:grid-cols-2">
              {IMAGE_MODELS.map((m) => {
                const selected = m.id === imageModel;
                return (
                  <button
                    key={m.id}
                    onClick={() => setImageModel(m.id)}
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
                Requires <code className="rounded bg-[var(--bg-elevated)] px-1">REPLICATE_API_TOKEN</code> in env.
              </p>
            )}
          </section>
        )}

        {modelsTab === "engine" && (
          <section className="surface p-5">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-ink">Workflow engine</h2>
              <p className="mt-0.5 text-sm text-mid">
                Runtime that executes every workflow start (campaign plan, single
                post, asset). Applies to all new runs across the app.
              </p>
            </div>
            <div className="grid gap-2.5 md:grid-cols-2">
              {engines.map((e) => {
                const selected = e.id === workflowEngine;
                const disabled = !e.available;
                return (
                  <button
                    key={e.id}
                    onClick={() => setWorkflowEngine(e.id)}
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
          </section>
        )}

        {modelsTab === "workflow" && (
          <section className="surface p-5">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-ink">Workflow LLM</h2>
              <p className="mt-0.5 text-sm text-mid">
                Default model for the orchestrator and every workflow run.
                Sub-agents inherit this unless overridden in the next tab. Models
                from providers without an API key are disabled.
              </p>
            </div>
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
                          onClick={() => setWorkflowModel(m.id)}
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
                <h3 className="text-sm font-semibold text-ink">
                  Brand extraction model
                </h3>
                <p className="mt-0.5 text-xs text-mid">
                  Used by Brand → Generate to read uploaded source docs and
                  draft brand-memory + design tokens. Must be a multimodal
                  model that can read PDFs (Anthropic Claude or Google Gemini).
                </p>
              </div>
              <select
                value={brandExtractModel}
                disabled={isPending}
                onChange={(e) => setBrandExtractModel(e.target.value as LlmModel)}
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
          </section>
        )}

        {modelsTab === "overrides" && (
          <section className="surface p-5">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-ink">
                Per-sub-agent overrides
              </h2>
              <p className="mt-0.5 text-sm text-mid">
                Pin a specific sub-agent to a different model. Leave on
                "Workflow default" to inherit the Workflow LLM. Per-call model
                overrides (e.g. from /workflow chat commands) still win.
              </p>
            </div>
            <div className="grid gap-2.5 md:grid-cols-2">
              {SUB_AGENT_KINDS.map((kind) => {
                const current = subAgentModels[kind] ?? "";
                return (
                  <div
                    key={kind}
                    className="surface-2 px-4 py-3"
                  >
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
                        setSubAgentModel(kind, v === "" ? null : (v as LlmModel));
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
          </section>
        )}
      </div>

      <div
        role="tabpanel"
        id="settings-tabpanel-research"
        aria-labelledby="settings-tab-research"
        hidden={active !== "research"}
        className="space-y-5"
      >
        <section className="surface p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-ink">
              Daily research keywords
            </h2>
            <p className="mt-0.5 text-sm text-mid">
              The Researcher scans these every day at 07:45 Kathmandu (02:00 UTC),
              fetches the latest news and updates per keyword, writes findings
              into the Knowledge Base, and posts the combined report at{" "}
              <a className="underline hover:text-ink" href="/research">
                /research
              </a>
              . Leave empty to disable the cron.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addKeyword();
                }
              }}
              placeholder="e.g. zero-knowledge proofs, Aleo network, Algorand DeFi"
              maxLength={120}
              className="field flex-1"
            />
            <button
              type="button"
              onClick={() => void addKeyword()}
              disabled={isPending || keywordDraft.trim().length === 0}
              className="btn btn-primary btn-sm"
            >
              Add keyword
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {researchKeywords.length === 0 ? (
              <p className="text-sm text-mid">
                No keywords yet. Add one above to start the daily scan.
              </p>
            ) : (
              researchKeywords.map((kw) => (
                <span
                  key={kw}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm text-ink"
                >
                  {kw}
                  <button
                    type="button"
                    onClick={() => void removeKeyword(kw)}
                    disabled={isPending}
                    aria-label={`Remove ${kw}`}
                    className="text-mid hover:text-danger transition-colors"
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          {researchKeywords.length >= 50 && (
            <p className="mt-2 text-xs text-mid">
              50-keyword cap reached. Remove one before adding more.
            </p>
          )}
        </section>

        <section className="surface p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-ink">Search provider</h2>
            <p className="mt-0.5 text-sm text-mid">
              External search API the Researcher hits to discover fresh URLs.
              Both have free tiers; pick whichever has a key configured.
            </p>
          </div>
          <div className="grid gap-2.5 md:grid-cols-2">
            {RESEARCH_SEARCH_PROVIDERS.map((p) => {
              const selected = p === researchProvider;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => void setResearchProvider(p)}
                  disabled={isPending || selected}
                  className={[
                    "h-full text-left surface-2 px-4 py-3 transition-colors",
                    selected
                      ? "border-accent ring-1 ring-accent"
                      : "hover:border-border-strong",
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
        </section>

        <section className="surface p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-ink">
              Embedding provider
            </h2>
            <p className="mt-0.5 text-sm text-mid">
              Powers the Knowledge Base, similar-content lookups, and
              common-mistake retrieval. Vectors stay 1536d across providers.
              Switching providers makes existing vectors invisible to search
              until you re-embed via the backfill route.
            </p>
          </div>
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
                  onClick={() => void setEmbeddingProvider(p)}
                  disabled={isPending || selected || !wired}
                  className={[
                    "h-full text-left surface-2 px-4 py-3 transition-colors",
                    selected
                      ? "border-accent ring-1 ring-accent"
                      : "hover:border-border-strong",
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
                      <span className="badge badge-success badge-dot">
                        active
                      </span>
                    )}
                    {!wired && (
                      <span className="badge badge-muted">soon</span>
                    )}
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
                onChange={(e) => void setEmbeddingModel(e.target.value)}
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
            <code className="text-ink">
              POST /api/admin/embeddings/backfill
            </code>
          </p>
        </section>
      </div>

      {usagePanel && (
        <div
          role="tabpanel"
          id="settings-tabpanel-usage"
          aria-labelledby="settings-tab-usage"
          hidden={active !== "usage"}
        >
          {usagePanel}
        </div>
      )}

      {error && (
        <p className="mt-4 text-sm text-[var(--danger)]">Error: {error}</p>
      )}
      {saved && (
        <p className="mt-4 text-sm text-[var(--success)] inline-flex items-center gap-1">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Settings saved.
        </p>
      )}
    </div>
  );
}
