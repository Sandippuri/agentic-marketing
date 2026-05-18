"use client";

import { useMemo, useState } from "react";
import type {
  PromptRegistryEntry,
  PromptRisk,
  PromptVariable,
} from "@marketing/agents/prompt-store";

export type PromptView = PromptRegistryEntry & {
  currentBody: string;
  hasOverride: boolean;
  overrideUpdatedAt: string | null;
};

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

const RISK_BADGE: Record<PromptRisk, { label: string; className: string }> = {
  low: { label: "low risk", className: "bg-emerald-500/15 text-emerald-300" },
  medium: { label: "medium risk", className: "bg-amber-500/15 text-amber-300" },
  high: { label: "HIGH RISK", className: "bg-rose-500/20 text-rose-300" },
};

export function PromptsList({ prompts }: { prompts: PromptView[] }) {
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => {
    const lower = filter.trim().toLowerCase();
    const filtered = lower
      ? prompts.filter(
          (p) =>
            p.label.toLowerCase().includes(lower) ||
            p.key.toLowerCase().includes(lower) ||
            p.description.toLowerCase().includes(lower) ||
            p.group.toLowerCase().includes(lower),
        )
      : prompts;
    const byGroup = new Map<string, PromptView[]>();
    for (const p of filtered) {
      if (!byGroup.has(p.group)) byGroup.set(p.group, []);
      byGroup.get(p.group)!.push(p);
    }
    return Array.from(byGroup.entries());
  }, [prompts, filter]);

  return (
    <div className="space-y-6">
      <div>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search prompts by label, key, group, description…"
          className="w-full max-w-md px-3 py-2 rounded-md bg-[var(--surface)] border border-[var(--border)] text-sm text-ink placeholder:text-faint"
        />
      </div>
      {groups.length === 0 && (
        <div className="text-sm text-mid">No prompts match.</div>
      )}
      {groups.map(([group, list]) => (
        <section key={group} className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">
            {group}
          </h2>
          <div className="space-y-3">
            {list.map((p) => (
              <PromptCard key={p.key} prompt={p} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PromptCard({ prompt }: { prompt: PromptView }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(prompt.currentBody);
  const [hasOverride, setHasOverride] = useState(prompt.hasOverride);
  const [updatedAt, setUpdatedAt] = useState(prompt.overrideUpdatedAt);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  const dirty = body !== prompt.currentBody;
  const isDefault = body === prompt.defaultBody;
  const risk = RISK_BADGE[prompt.risk] ?? RISK_BADGE.medium;

  async function save() {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(
        `/api/super/prompts/${encodeURIComponent(prompt.key)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `save failed (${res.status})`);
      }
      const json = (await res.json()) as {
        body: string | null;
        updatedAt: string;
      };
      setHasOverride(true);
      setUpdatedAt(json.updatedAt);
      setStatus({ kind: "saved", at: Date.now() });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function resetToDefault() {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(
        `/api/super/prompts/${encodeURIComponent(prompt.key)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: null }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `reset failed (${res.status})`);
      }
      setBody(prompt.defaultBody);
      setHasOverride(false);
      setUpdatedAt(null);
      setStatus({ kind: "saved", at: Date.now() });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  return (
    <div className="surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left p-4 flex items-start gap-3"
      >
        <span
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${risk.className}`}
          title={`risk: ${prompt.risk}`}
        >
          {risk.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-ink truncate">
              {prompt.label}
            </span>
            {hasOverride && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)]">
                override
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-mid font-mono">{prompt.key}</div>
          <div className="mt-1.5 text-xs text-mid line-clamp-2">
            {prompt.description}
          </div>
        </div>
        <span className="text-xs text-faint shrink-0">
          {open ? "Collapse" : "Edit"}
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--border)] p-4 space-y-3 bg-[var(--surface-2)]">
          {prompt.variables.length > 0 && (
            <div className="text-xs text-mid">
              <div className="font-semibold text-ink mb-1">Variables</div>
              <ul className="space-y-1">
                {prompt.variables.map((v: PromptVariable) => (
                  <li key={v.name} className="font-mono">
                    <code className="text-[var(--accent)]">{`{{${v.name}}}`}</code>{" "}
                    — {v.description}
                    {v.example && (
                      <span className="text-faint"> e.g. {v.example}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(20, Math.max(6, body.split("\n").length + 1))}
            className="w-full px-3 py-2 rounded-md bg-[var(--surface)] border border-[var(--border)] text-sm text-ink font-mono leading-relaxed"
            spellCheck={false}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-mid">
              {hasOverride
                ? `Last saved ${updatedAt ? new Date(updatedAt).toLocaleString() : "—"}`
                : "Using built-in default (no override)"}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBody(prompt.defaultBody)}
                disabled={isDefault}
                className="btn btn-secondary btn-sm"
              >
                Restore default
              </button>
              {hasOverride && (
                <button
                  type="button"
                  onClick={resetToDefault}
                  disabled={status.kind === "saving"}
                  className="btn btn-secondary btn-sm"
                  title="Delete the override row; agents will fall back to the built-in default."
                >
                  Clear override
                </button>
              )}
              <button
                type="button"
                onClick={save}
                disabled={!dirty || status.kind === "saving"}
                className="btn btn-primary btn-sm"
              >
                {status.kind === "saving" ? "Saving…" : "Save"}
              </button>
            </div>
          </div>

          {status.kind === "saved" && (
            <div className="text-xs text-[var(--success)]">Saved.</div>
          )}
          {status.kind === "error" && (
            <div className="text-xs text-[var(--danger)]">{status.message}</div>
          )}
          {prompt.risk === "high" && (
            <div className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded p-2">
              <strong>High-risk prompt.</strong> This drives tool routing or
              critical agent behavior. Removing flow descriptions or structural
              rules can break tool calls or output parsing across the platform.
              Test on a draft campaign or chat before relying on the new wording.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
