"use client";

import { useState, useTransition } from "react";
import { CHANNELS, type Channel, type WorkspaceMarketContext } from "@marketing/shared-types";

const CHANNEL_LABELS: Record<Channel, string> = {
  internal_blog: "Blog",
  linkedin: "LinkedIn",
  x: "X / Twitter",
  instagram: "Instagram",
  facebook: "Facebook",
  email_hubspot: "Email (HubSpot)",
  email_mailchimp: "Email (Mailchimp)",
};

type Editable = {
  primaryCountry: string;
  targetRegions: string;
  languages: string;
  primaryChannels: Set<Channel>;
};

function toEditable(value: WorkspaceMarketContext): Editable {
  return {
    primaryCountry: value.primaryCountry ?? "",
    targetRegions: value.targetRegions.join(", "),
    languages: value.languages.join(", "),
    primaryChannels: new Set(
      value.primaryChannels.filter((c): c is Channel =>
        (CHANNELS as readonly string[]).includes(c),
      ),
    ),
  };
}

function splitCsv(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function patchMarketContext(
  body: Partial<WorkspaceMarketContext>,
): Promise<WorkspaceMarketContext> {
  const res = await fetch("/api/workspace/market-context", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `PATCH /api/workspace/market-context → ${res.status}`);
  }
  return res.json() as Promise<WorkspaceMarketContext>;
}

export function MarketForm({ initial }: { initial: WorkspaceMarketContext }) {
  const [edit, setEdit] = useState<Editable>(toEditable(initial));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggleChannel(ch: Channel) {
    setSaved(false);
    setEdit((prev) => {
      const next = new Set(prev.primaryChannels);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      return { ...prev, primaryChannels: next };
    });
  }

  function save() {
    setError(null);
    setSaved(false);
    const country = edit.primaryCountry.trim().toUpperCase();
    if (country.length > 0 && !/^[A-Z]{2}$/.test(country)) {
      setError("Primary country must be a 2-letter ISO code (e.g. NP, US, IN).");
      return;
    }
    const payload: Partial<WorkspaceMarketContext> = {
      primaryCountry: country.length > 0 ? country : null,
      targetRegions: splitCsv(edit.targetRegions),
      languages: splitCsv(edit.languages),
      primaryChannels: Array.from(edit.primaryChannels),
    };
    startTransition(async () => {
      try {
        const next = await patchMarketContext(payload);
        setEdit(toEditable(next));
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  return (
    <div className="surface p-5 space-y-4">
      <Field
        label="Primary country"
        hint="ISO 3166-1 alpha-2 (e.g. NP, US, IN). Where the business primarily operates."
      >
        <input
          type="text"
          value={edit.primaryCountry}
          onChange={(e) => {
            setSaved(false);
            setEdit({ ...edit, primaryCountry: e.target.value });
          }}
          placeholder="NP"
          maxLength={2}
          className="field mono uppercase w-24"
        />
      </Field>

      <Field
        label="Target regions"
        hint="Comma-separated. Countries (ISO codes) or labels like 'South Asia', 'Bay Area'."
      >
        <input
          type="text"
          value={edit.targetRegions}
          onChange={(e) => {
            setSaved(false);
            setEdit({ ...edit, targetRegions: e.target.value });
          }}
          placeholder="NP, IN, BD"
          className="field"
        />
      </Field>

      <Field
        label="Languages"
        hint="Comma-separated BCP-47 tags. e.g. en, ne, hi, en-US."
      >
        <input
          type="text"
          value={edit.languages}
          onChange={(e) => {
            setSaved(false);
            setEdit({ ...edit, languages: e.target.value });
          }}
          placeholder="en, ne"
          className="field"
        />
      </Field>

      <Field
        label="Primary channels"
        hint="Which channels matter most for this workspace. The strategist will favour these when building a calendar."
      >
        <div className="flex flex-wrap gap-2">
          {CHANNELS.map((ch) => {
            const active = edit.primaryChannels.has(ch);
            return (
              <button
                key={ch}
                type="button"
                onClick={() => toggleChannel(ch)}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  active
                    ? "bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-ink)]"
                    : "border-[var(--border)] text-mid hover:bg-[var(--surface-2)]"
                }`}
              >
                {CHANNEL_LABELS[ch]}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="btn btn-primary btn-sm"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {saved && !isPending && (
          <span className="text-sm text-[var(--success)] inline-flex items-center gap-1">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Saved
          </span>
        )}
        {error && <span className="text-sm text-[var(--danger)]">Error: {error}</span>}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-col gap-1 mb-1.5">
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="text-xs text-mid">{hint}</span>
      </div>
      {children}
    </div>
  );
}
