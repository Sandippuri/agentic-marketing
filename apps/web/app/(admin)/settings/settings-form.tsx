"use client";

import { useState, useTransition } from "react";
import type { Channel, SettingsShape } from "@marketing/shared-types";

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

type Props = { initialSettings: Partial<SettingsShape> };

async function patchSettings(body: Partial<SettingsShape>) {
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

  return (
    <div className="space-y-10">
      {/* Kill switch */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 className="font-semibold text-lg mb-1">Publishing kill switch</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              When active, the Distributor stops picking up new jobs and cancels
              all in-flight queued jobs.
            </p>
          </div>
          <button
            onClick={toggleKillSwitch}
            disabled={isPending}
            className={[
              "shrink-0 rounded-lg px-5 py-2 text-sm font-semibold transition-colors disabled:opacity-50",
              killSwitch
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-700 dark:hover:bg-zinc-300 text-white dark:text-zinc-900",
            ].join(" ")}
          >
            {killSwitch ? "🔴 ACTIVE — click to disable" : "Enable kill switch"}
          </button>
        </div>
        {killSwitch && (
          <p className="mt-3 text-sm font-medium text-red-600 dark:text-red-400">
            ⚠️ Publishing is paused. No new content will be distributed.
          </p>
        )}
      </section>

      {/* Channel caps */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
        <h2 className="font-semibold text-lg mb-1">Daily channel caps</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
          Maximum posts per channel per day. Leave blank for no limit.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {CHANNELS.map((ch) => (
            <div key={ch} className="flex items-center gap-3">
              <label className="text-sm w-36 shrink-0">{CHANNEL_LABELS[ch]}</label>
              <input
                type="number"
                min={0}
                value={caps[ch] ?? ""}
                onChange={(e) => setCaps((c) => ({ ...c, [ch]: e.target.value }))}
                placeholder="∞"
                className="w-20 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm text-center"
              />
            </div>
          ))}
        </div>
        <button
          onClick={saveCaps}
          disabled={isPending}
          className="mt-5 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          Save caps
        </button>
      </section>

      {/* Approval policy */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
        <h2 className="font-semibold text-lg mb-1">Approval policy</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          Single-approver publishes on one approval. Two-approver requires two
          distinct team members.
        </p>
        <div className="flex gap-3">
          {(["single", "two_approver"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setApprovalMode(mode)}
              disabled={isPending || approvalMode === mode}
              className={[
                "rounded-lg px-4 py-1.5 text-sm font-medium border transition-colors disabled:opacity-50",
                approvalMode === mode
                  ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 border-transparent"
                  : "border-zinc-300 dark:border-zinc-700 hover:border-zinc-500",
              ].join(" ")}
            >
              {mode === "single" ? "Single approver" : "Two approvers"}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">Error: {error}</p>
      )}
      {saved && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          Settings saved.
        </p>
      )}
    </div>
  );
}
