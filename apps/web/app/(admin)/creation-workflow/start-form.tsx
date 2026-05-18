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
import { useEffect, useRef, useState, useTransition } from "react";
import {
  CHANNELS,
  type Channel,
  type WorkflowMedia,
} from "@marketing/shared-types";
import type { EngineDescriptor, EngineId, WorkflowKind } from "@/lib/workflow-engines";

type CalendarPreviewItem = {
  index: number;
  title: string;
  type: string | null;
  stage: string | null;
  phase: string | null;
  scheduledFor: string | null;
};

type Kind = WorkflowKind;

// Media picker — same labels surfaced in the Draft button + execute_campaign
// per-item dropdown so the user sees one consistent vocabulary across forms.
const MEDIA_OPTIONS: Array<{
  value: WorkflowMedia;
  label: string;
  hint: string;
}> = [
  { value: "auto", label: "Auto", hint: "Image always; video when the channel supports it." },
  { value: "image", label: "Image", hint: "Image only — never run video." },
  { value: "video", label: "Video", hint: "Video only — forced even on image-only channels." },
  { value: "both", label: "Both", hint: "Image AND video, regardless of channel default." },
];

// Channels where 'auto' won't produce a video on its own. The form surfaces
// a tiny hint when the user leaves media on Auto so the result isn't
// surprising. Kept in sync with VIDEO_ENABLED_CONTENT_TYPES — single source
// would mean importing CONTENT_TYPE through the channel mapping, which the
// form doesn't already do.
const NON_VIDEO_AUTO_CHANNELS = new Set<Channel>([
  "internal_blog",
  "email_hubspot",
  "email_mailchimp",
  "instagram",
  "facebook",
]);

export type CampaignOption = { id: string; name: string; slug: string };

const KINDS: Array<{ value: Kind; label: string; hint: string }> = [
  {
    value: "campaign",
    label: "Campaign plan",
    hint: "Strategist drafts a brief and calendar from your goal.",
  },
  {
    value: "execute_campaign",
    label: "Execute campaign",
    hint: "Fan out one single-post run per calendar item on an existing campaign.",
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
  // Media pick for single_post / asset / execute_campaign-default. Per-item
  // overrides for execute_campaign live in `approvedMedia` below.
  const [media, setMedia] = useState<WorkflowMedia>("auto");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{
    workflowRunId: string;
    engine: EngineId;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  // Inspiration image — optional. On file pick we upload immediately so by
  // the time the user submits, the storage path is already in hand. Keeps
  // the submit path identical to the no-inspiration case (single JSON POST).
  const [inspiration, setInspiration] = useState<{
    storagePath: string;
    signedUrl: string;
  } | null>(null);
  const [inspirationUploading, setInspirationUploading] = useState(false);
  const [inspirationError, setInspirationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // execute_campaign — pre-flight checklist of the campaign's calendar
  // items. We default to NOTHING checked so the user has to explicitly
  // opt-in per item — no surprise 14-post fan-out.
  const [calendarItems, setCalendarItems] = useState<CalendarPreviewItem[] | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [approvedIndices, setApprovedIndices] = useState<Set<number>>(new Set());
  // Per-item media override map (index → choice). Items not in the map fall
  // back to the form-level `media`. Cleared whenever the calendar reloads.
  const [approvedMedia, setApprovedMedia] = useState<Map<number, WorkflowMedia>>(
    new Map(),
  );

  useEffect(() => {
    if (kind !== "execute_campaign" || !campaignId) {
      setCalendarItems(null);
      setCalendarError(null);
      setApprovedIndices(new Set());
      setApprovedMedia(new Map());
      return;
    }
    let cancelled = false;
    setCalendarLoading(true);
    setCalendarError(null);
    fetch(`/api/campaigns/${campaignId}/calendar`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          items?: CalendarPreviewItem[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setCalendarError(data.error ?? `Failed to load (${res.status})`);
          setCalendarItems(null);
          return;
        }
        setCalendarItems(data.items ?? []);
        setApprovedIndices(new Set()); // default: nothing approved
        setApprovedMedia(new Map());
      })
      .catch((err) => {
        if (cancelled) return;
        setCalendarError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setCalendarLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, campaignId]);

  const toggleApproved = (idx: number) => {
    setApprovedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const setItemMedia = (idx: number, value: WorkflowMedia) => {
    setApprovedMedia((prev) => {
      const next = new Map(prev);
      if (value === "auto" && !prev.has(idx)) {
        // No-op: "auto" with nothing stored is already the implicit default.
        return prev;
      }
      next.set(idx, value);
      return next;
    });
  };

  const engineSupportsKind = engineDescriptor
    ? engineDescriptor.available && engineDescriptor.kinds.includes(kind)
    : false;

  // Single-post + Vercel always inserts a fresh campaign-less row, so the
  // form-level requireCampaign no longer fires for any current engine.
  const requireCampaign = false;
  const noCampaigns = requireCampaign && campaigns.length === 0;
  const engineLabel = engineDescriptor?.label ?? engine;

  const onInspirationPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setInspirationError(null);
    setInspirationUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/uploads/inspiration-images", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as {
        storagePath?: string;
        signedUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.storagePath || !data.signedUrl) {
        setInspirationError(data.error ?? `Upload failed (${res.status})`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      setInspiration({ storagePath: data.storagePath, signedUrl: data.signedUrl });
    } catch (err) {
      setInspirationError((err as Error).message);
    } finally {
      setInspirationUploading(false);
    }
  };

  const clearInspiration = () => {
    setInspiration(null);
    setInspirationError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (kind === "execute_campaign") {
      if (!campaignId) {
        setError("Pick the campaign whose calendar should be executed.");
        return;
      }
      if (approvedIndices.size === 0) {
        setError("Approve at least one calendar item before starting.");
        return;
      }
    } else if (!request.trim()) {
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
      // execute_campaign drives off the campaign's calendar — the API still
      // needs a non-empty request string for the workflow_runs log, so we
      // synthesise one from the campaign name when the user leaves it blank.
      request:
        request.trim() ||
        (kind === "execute_campaign"
          ? `Execute calendar items for ${campaigns.find((c) => c.id === campaignId)?.name ?? "campaign"}`
          : ""),
    };
    if (kind === "single_post") {
      if (campaignId) body.campaignId = campaignId;
      if (channel) body.channel = channel;
      if (media !== "auto") body.media = media;
    }
    if (kind === "asset") {
      // Asset workflow refuses video at the API level; the UI hides the
      // video pills for kind=asset so we only ever send image/auto here.
      if (media !== "auto") body.media = media;
    }
    if (kind === "execute_campaign") {
      body.campaignId = campaignId;
      if (channel) body.channel = channel;
      const indices = Array.from(approvedIndices).sort((a, b) => a - b);
      body.itemIndices = indices;
      // Build the parallel itemMedia array only when at least one item
      // carries an explicit pick — otherwise let the server treat them all
      // as `media` (or auto) and avoid sending a noisy uniform payload.
      const hasPerItem = indices.some((i) => approvedMedia.has(i));
      if (hasPerItem) {
        body.itemMedia = indices.map((i) => approvedMedia.get(i) ?? media);
      }
      if (media !== "auto") body.media = media;
    }
    // Inspiration is honoured by kinds that touch image generation. The
    // campaign-plan kind doesn't, so we drop it there to avoid leading users
    // to think it'll change anything.
    if (kind !== "campaign" && kind !== "execute_campaign" && inspiration) {
      body.inspirationImagePath = inspiration.storagePath;
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
      setInspiration(null);
      setInspirationError(null);
      setMedia("auto");
      setApprovedMedia(new Map());
      if (fileInputRef.current) fileInputRef.current.value = "";
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
        required={kind !== "execute_campaign"}
        placeholder={
          kind === "campaign"
            ? "e.g. Q3 product launch — target devs, focus on AI agents, 6-week cadence."
            : kind === "single_post"
              ? "e.g. LinkedIn post announcing the new RAG benchmarks. Punchy, data-led."
              : kind === "execute_campaign"
                ? "Optional notes for the run. The campaign brief + calendar will be used regardless."
                : "e.g. Hero image for the launch post. Editorial, dark theme."
        }
        className="field"
      />

      {/* MEDIA PICKER — shown for every kind that produces visuals. Hides
          video pills for kind=asset because the standalone asset workflow
          is image-only; surfacing video there would 400 at submit. */}
      {kind !== "campaign" && (
        <div className="mt-3">
          <div className="section-title mb-1.5 flex items-center justify-between">
            <span>
              Media{" "}
              <span className="text-mid normal-case tracking-normal">
                {kind === "execute_campaign"
                  ? "(default for all approved items — override per-item below)"
                  : "(hard override — bypasses channel defaults)"}
              </span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {MEDIA_OPTIONS.filter(
              (m) => !(kind === "asset" && (m.value === "video" || m.value === "both")),
            ).map((m) => {
              const selected = media === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMedia(m.value)}
                  className={[
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    selected
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-ink"
                      : "border-[var(--border)] bg-[var(--surface)] text-mid hover:border-[var(--border-strong)] hover:text-ink",
                  ].join(" ")}
                >
                  {m.label}
                </button>
              );
            })}
            <span className="ml-1 text-xs text-mid leading-snug">
              {MEDIA_OPTIONS.find((m) => m.value === media)?.hint}
            </span>
          </div>
          {kind === "single_post" &&
            media === "auto" &&
            channel &&
            NON_VIDEO_AUTO_CHANNELS.has(channel) && (
              <div className="mt-1.5 text-xs text-mid">
                Heads up: {channel} doesn't get a video on Auto. Pick{" "}
                <strong className="text-ink">Video</strong> or{" "}
                <strong className="text-ink">Both</strong> to force one.
              </div>
            )}
        </div>
      )}

      {kind !== "campaign" && kind !== "execute_campaign" && (
        <div className="mt-3">
          <div className="section-title mb-1.5 flex items-center justify-between">
            <span>
              Inspiration image{" "}
              <span className="text-mid normal-case tracking-normal">(optional)</span>
            </span>
            {inspiration && (
              <button
                type="button"
                onClick={clearInspiration}
                className="text-xs text-mid hover:text-ink underline normal-case tracking-normal"
              >
                Remove
              </button>
            )}
          </div>
          {inspiration ? (
            <div className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={inspiration.signedUrl}
                alt="Inspiration preview"
                className="h-16 w-16 rounded object-cover"
              />
              <div className="text-xs text-mid">
                Will be used as a style reference. The image model will match
                its mood/palette/composition but render your subject — not the
                inspiration's subject.
              </div>
            </div>
          ) : (
            <label
              className={[
                "flex cursor-pointer items-center justify-between rounded-md border border-dashed px-3 py-2 text-xs",
                inspirationUploading
                  ? "border-[var(--border)] text-mid"
                  : "border-[var(--border)] text-mid hover:border-[var(--border-strong)] hover:text-ink",
              ].join(" ")}
            >
              <span>
                {inspirationUploading
                  ? "Uploading…"
                  : "Attach a reference image (PNG/JPEG/WebP, ≤5MB) — for inspiration only; the final post will be styled around your brand."}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onInspirationPick}
                disabled={inspirationUploading}
                className="hidden"
              />
              <span className="btn text-xs">Choose</span>
            </label>
          )}
          {inspirationError && (
            <div className="mt-1.5 text-xs text-[var(--danger)]">
              {inspirationError}
            </div>
          )}
        </div>
      )}

      {kind === "execute_campaign" && (
        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="section-title mb-1.5 block">
              Campaign{" "}
              <span className="text-mid normal-case tracking-normal">(required)</span>
            </span>
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              required
              disabled={campaigns.length === 0}
              className="field"
            >
              <option value="">— pick a campaign —</option>
              {campaigns.length === 0 ? (
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

          {campaignId && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="section-title">
                  Pre-flight approval{" "}
                  <span className="text-mid normal-case tracking-normal">
                    — pick which items to draft. Each will go through its own
                    Draft → Approval gate before publishing.
                  </span>
                </span>
                {calendarItems && calendarItems.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() =>
                        setApprovedIndices(
                          new Set(calendarItems.map((i) => i.index)),
                        )
                      }
                      className="text-mid hover:text-ink underline"
                    >
                      Select all
                    </button>
                    <span className="text-mid">·</span>
                    <button
                      type="button"
                      onClick={() => setApprovedIndices(new Set())}
                      className="text-mid hover:text-ink underline"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              {calendarLoading && (
                <div className="text-xs text-mid">Loading calendar…</div>
              )}
              {calendarError && (
                <div className="text-xs text-[var(--danger)]">{calendarError}</div>
              )}
              {!calendarLoading && !calendarError && calendarItems && calendarItems.length === 0 && (
                <div className="text-xs text-mid">
                  This campaign has no calendar items yet — run a Campaign plan
                  first so the Strategist writes one.
                </div>
              )}
              {!calendarLoading && calendarItems && calendarItems.length > 0 && (
                <ul className="space-y-1.5">
                  {calendarItems.map((item) => {
                    const checked = approvedIndices.has(item.index);
                    const itemMedia = approvedMedia.get(item.index) ?? media;
                    return (
                      <li key={item.index} className="flex items-center gap-2">
                        <label className="flex flex-1 min-w-0 items-start gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleApproved(item.index)}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="text-ink font-medium">
                              {item.title}
                            </span>
                            <span className="ml-2 text-mid">
                              {[item.type, item.stage, item.phase, item.scheduledFor]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </label>
                        {/* Per-item media override. Disabled until the item
                            is checked so the affordance matches the run
                            semantics — unapproved items never spawn. */}
                        <select
                          value={itemMedia}
                          onChange={(e) =>
                            setItemMedia(
                              item.index,
                              e.target.value as WorkflowMedia,
                            )
                          }
                          disabled={!checked}
                          title="Media for this item"
                          className="field py-0.5 text-xs w-auto disabled:opacity-40"
                        >
                          {MEDIA_OPTIONS.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </li>
                    );
                  })}
                </ul>
              )}
              {calendarItems && calendarItems.length > 0 && (
                <div className="mt-2 text-xs text-mid">
                  {approvedIndices.size} of {calendarItems.length} approved.
                </div>
              )}
            </div>
          )}
        </div>
      )}

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
