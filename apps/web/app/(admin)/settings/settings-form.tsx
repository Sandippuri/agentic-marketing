"use client";

import { useState, useTransition } from "react";
import type { Channel, SettingsShape } from "@marketing/shared-types";

// Workspace-scoped settings only. AI model picks, workflow engine, research
// search provider, and embedding provider all moved to /super/models — the
// platform admin sets those once and every workspace inherits. What's left
// here is what a workspace owner can actually decide for themselves.

const CHANNELS: Channel[] = [
  "internal_blog",
  "linkedin",
  "x",
  "facebook",
  "instagram",
  "email_hubspot",
  "email_mailchimp",
];

const CHANNEL_LABELS: Record<Channel, string> = {
  internal_blog: "Internal blog",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
  instagram: "Instagram",
  facebook: "Facebook",
  email_hubspot: "Email (HubSpot)",
  email_mailchimp: "Email (Mailchimp)",
};

type TabKey = "publishing" | "research";

type Props = {
  initialSettings: Partial<SettingsShape>;
};

type PatchBody = Partial<
  Pick<
    SettingsShape,
    "kill_switch" | "channel_caps" | "approval_policy" | "research_keywords"
  >
>;

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

export function SettingsForm({ initialSettings }: Props) {
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

  const killSwitch = settings.kill_switch ?? false;
  const approvalMode = settings.approval_policy?.mode ?? "single";
  const researchKeywords: string[] = Array.isArray(settings.research_keywords)
    ? settings.research_keywords
    : [];
  const [keywordDraft, setKeywordDraft] = useState("");

  function apply(body: PatchBody) {
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

  function toggleKillSwitch() {
    apply({ kill_switch: !killSwitch });
  }

  function saveCaps() {
    const channel_caps: Partial<Record<Channel, number>> = {};
    for (const ch of CHANNELS) {
      const v = Number(caps[ch]);
      if (!Number.isNaN(v) && caps[ch] !== "") channel_caps[ch] = v;
    }
    apply({ channel_caps });
  }

  function setApprovalMode(mode: "single" | "two_approver") {
    apply({ approval_policy: { mode } });
  }

  async function saveResearchKeywords(next: string[]) {
    apply({ research_keywords: next });
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

  const tabs: { key: TabKey; label: string }[] = [
    { key: "publishing", label: "Publishing" },
    { key: "research", label: "Research" },
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
              onClick={() => setActive(tab.key)}
              className={[
                "relative px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2",
                isActive
                  ? "text-ink border-[var(--accent)]"
                  : "text-mid border-transparent hover:text-ink",
              ].join(" ")}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
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
          <h3 className="text-sm font-semibold text-ink">
            Looking for model / provider settings?
          </h3>
          <p className="mt-1 text-sm text-mid">
            Image, video, workflow LLM, sub-agent overrides, search provider, and
            embedding model are now picked once by the platform admin. Workspace
            owners inherit those choices automatically.
          </p>
        </section>
      </div>

      {error && (
        <p className="mt-4 text-sm text-[var(--danger)]">Error: {error}</p>
      )}
      {saved && (
        <p className="mt-4 text-sm text-[var(--success)] inline-flex items-center gap-1">
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
          Settings saved.
        </p>
      )}
    </div>
  );
}
