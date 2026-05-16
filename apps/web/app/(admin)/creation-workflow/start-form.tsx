"use client";

// Manual workflow trigger. Three kinds:
//   - kind: campaign | single_post | asset
//
// The workflow engine (custom | vercel | cloudflare) is configured globally
// in Settings — every run uses that one engine. On submit, POSTs
// /api/workflow-runs/start; the API resolves the engine from
// settings.workflow_engine (the engine prop here is for UX display only).
// The unified dispatcher opens a workflow_runs row, then delegates to the
// engine adapter. The new run appears on this page via the realtime
// invalidator.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CHANNELS, type Channel } from "@marketing/shared-types";
import type { EngineDescriptor, EngineId, WorkflowKind } from "@/lib/workflow-engines";

type Kind = WorkflowKind;

export type CampaignOption = { id: string; name: string; slug: string };

const KINDS: Array<{ value: Kind; label: string; hint: string }> = [
  {
    value: "campaign",
    label: "Campaign plan",
    hint: "Strategist drafts a brief and calendar from your goal.",
  },
  {
    value: "single_post",
    label: "Single post",
    hint: "Content agent drafts one post for an existing campaign.",
  },
  {
    value: "asset",
    label: "Asset only",
    hint: "Asset agent generates a visual from your brief.",
  },
];

export function StartForm({
  campaigns,
  engine,
  engineDescriptor,
  defaultOpen = false,
}: {
  campaigns: CampaignOption[];
  engine: EngineId;
  engineDescriptor: EngineDescriptor | null;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [kind, setKind] = useState<Kind>("campaign");
  const [request, setRequest] = useState("");
  const [campaignId, setCampaignId] = useState<string>(campaigns[0]?.id ?? "");
  const [channel, setChannel] = useState<Channel | "">("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{
    workflowRunId: string;
    engine: EngineId;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const engineSupportsKind = engineDescriptor
    ? engineDescriptor.available && engineDescriptor.kinds.includes(kind)
    : false;

  // Single-post + Vercel always inserts a fresh campaign-less row, so the
  // form-level requireCampaign no longer fires for any current engine.
  const requireCampaign = false;
  const noCampaigns = requireCampaign && campaigns.length === 0;
  const engineLabel = engineDescriptor?.label ?? engine;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!request.trim()) {
      setError("Brief is required.");
      return;
    }
    if (requireCampaign && !campaignId) {
      setError("Pick a campaign for a single post on the custom engine.");
      return;
    }
    if (!engineSupportsKind) {
      setError(
        `The configured engine (${engineLabel}) doesn't support ${KINDS.find((k) => k.value === kind)?.label.toLowerCase()}. Change it in Settings.`,
      );
      return;
    }

    // engine is intentionally NOT sent — the API resolves it from
    // settings.workflow_engine. The `engine` prop is for the UX preview.
    const body: Record<string, unknown> = {
      kind,
      request: request.trim(),
    };
    if (kind === "single_post") {
      if (campaignId) body.campaignId = campaignId;
      if (channel) body.channel = channel;
    }

    try {
      const res = await fetch("/api/workflow-runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Server returned ${res.status}.`);
        return;
      }
      const data = (await res.json()) as {
        workflowRunId: string;
        engine: EngineId;
      };
      setSubmitted({ workflowRunId: data.workflowRunId, engine: data.engine });
      setRequest("");
      setIsOpen(false);
      // Pull a fresh server render so the new run card shows up.
      startTransition(() => router.refresh());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── Collapsed: a thin bar with the trigger + last-run feedback ──────────
  if (!isOpen) {
    return (
      <div className="surface mb-5 flex flex-wrap items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setIsOpen(true);
              setError(null);
            }}
            className="btn btn-primary text-sm"
          >
            + Start a workflow
          </button>
          {submitted ? (
            <span className="text-xs text-[var(--success)] truncate">
              Started {submitted.workflowRunId.slice(0, 8)} on{" "}
              <strong className="font-semibold">{submitted.engine}</strong>.
            </span>
          ) : (
            <span className="text-xs text-mid truncate">
              via <strong className="font-semibold text-ink">{engineLabel}</strong>
            </span>
          )}
        </div>
        <a
          href="/settings"
          className="text-xs text-mid hover:text-ink underline shrink-0"
        >
          Engine settings
        </a>
      </div>
    );
  }

  // ── Expanded: compact form ──────────────────────────────────────────────
  return (
    <form onSubmit={onSubmit} className="surface mb-5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Start a workflow</h2>
          <span className="text-xs text-mid">
            via <span className="text-ink">{engineLabel}</span>
            {engineDescriptor && !engineDescriptor.available && (
              <span className="badge badge-neutral ml-2">soon</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <a
            href="/settings"
            className="text-xs text-mid hover:text-ink underline"
          >
            Change engine
          </a>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="text-xs text-mid hover:text-ink"
            aria-label="Close form"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Segmented kind picker — pill row instead of giant cards */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {KINDS.map((k) => {
          const selected = kind === k.value;
          return (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              className={[
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                selected
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-ink"
                  : "border-[var(--border)] bg-[var(--surface)] text-mid hover:border-[var(--border-strong)] hover:text-ink",
              ].join(" ")}
            >
              {k.label}
            </button>
          );
        })}
        <span className="ml-1 text-xs text-mid leading-snug">
          {KINDS.find((k) => k.value === kind)?.hint}
        </span>
      </div>

      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        rows={3}
        required
        placeholder={
          kind === "campaign"
            ? "e.g. Q3 product launch — target devs, focus on AI agents, 6-week cadence."
            : kind === "single_post"
              ? "e.g. LinkedIn post announcing the new RAG benchmarks. Punchy, data-led."
              : "e.g. Hero image for the launch post. Editorial, dark theme."
        }
        className="field"
      />

      {kind === "single_post" && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="section-title mb-1.5 block">
              Campaign{" "}
              <span className="text-mid normal-case tracking-normal">
                {requireCampaign ? "(required)" : "(optional)"}
              </span>
            </span>
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              required={requireCampaign}
              disabled={noCampaigns}
              className="field"
            >
              {!requireCampaign && (
                <option value="">(let the workflow pick / create)</option>
              )}
              {noCampaigns ? (
                <option value="">No campaigns — run a Campaign plan first</option>
              ) : (
                campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.slug})
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="block">
            <span className="section-title mb-1.5 block">
              Channel{" "}
              <span className="text-mid normal-case tracking-normal">(optional)</span>
            </span>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel | "")}
              className="field"
            >
              <option value="">(let the agent decide)</option>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {engineDescriptor && engineDescriptor.available && !engineSupportsKind && (
        <div className="mt-3 rounded-md border border-[var(--warn)] bg-[var(--warn-soft,transparent)] px-3 py-2 text-xs text-[var(--warn)]">
          {engineLabel} doesn't run{" "}
          {KINDS.find((k) => k.value === kind)?.label.toLowerCase()} yet — change
          the engine in Settings or pick another kind.
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-mid">
          Once started, the run can't be stopped.
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="btn"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending || noCampaigns || !engineSupportsKind}
            className="btn btn-primary"
          >
            {isPending ? "Starting…" : "Start creation"}
          </button>
        </div>
      </div>
    </form>
  );
}
