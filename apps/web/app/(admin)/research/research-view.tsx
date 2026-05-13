"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  RESEARCH_SEARCH_PROVIDERS,
  type ResearchSearchProvider,
} from "@marketing/shared-types";
import type { ResearchReport } from "@/lib/research-store";

const POLL_INTERVAL_MS = 5_000;
// Workflow can take a few minutes per keyword × N keywords; cap polling so a
// stuck run doesn't spin forever in the UI.
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

type RunResponse = { runId?: string; status?: string; error?: string };

async function startResearchRun(body: {
  keywords?: string[];
  provider?: ResearchSearchProvider;
}): Promise<RunResponse> {
  const res = await fetch("/api/research/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as RunResponse;
  if (!res.ok) {
    throw new Error(json.error ?? `POST /api/research/run → ${res.status}`);
  }
  return json;
}

export function ResearchView({ report }: { report: ResearchReport | null }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customKeywords, setCustomKeywords] = useState("");
  const [customProvider, setCustomProvider] = useState<ResearchSearchProvider | "">("");

  // Run tracking: we capture the report.generatedAt at click-time as the
  // baseline, then poll the server component until a newer report arrives.
  const [isRunning, setIsRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [justCompletedAt, setJustCompletedAt] = useState<string | null>(null);
  const baselineRef = useRef<string | null>(report?.generatedAt ?? null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Detect that the polled report is newer than the baseline → done.
  useEffect(() => {
    if (!isRunning) return;
    const current = report?.generatedAt ?? null;
    if (current && current !== baselineRef.current) {
      setIsRunning(false);
      setJustCompletedAt(current);
      baselineRef.current = current;
    }
  }, [report?.generatedAt, isRunning]);

  // Poll the server component while running so it re-fetches the latest report.
  useEffect(() => {
    if (!isRunning) return;
    const poll = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    const timeout = setTimeout(() => setIsRunning(false), POLL_TIMEOUT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(timeout);
    };
  }, [isRunning, router]);

  // Elapsed timer for the running banner.
  useEffect(() => {
    if (!isRunning || !runStartedAt) {
      setElapsedSec(0);
      return;
    }
    setElapsedSec(Math.floor((Date.now() - runStartedAt) / 1000));
    const tick = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - runStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [isRunning, runStartedAt]);

  function triggerRun(body: {
    keywords?: string[];
    provider?: ResearchSearchProvider;
  }) {
    setError(null);
    setLastRunId(null);
    setJustCompletedAt(null);
    baselineRef.current = report?.generatedAt ?? null;
    startTransition(async () => {
      try {
        const r = await startResearchRun(body);
        setLastRunId(r.runId ?? null);
        setRunStartedAt(Date.now());
        setIsRunning(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  function runConfigured() {
    triggerRun({});
  }

  function runCustom() {
    const keywords = customKeywords
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (keywords.length === 0) {
      setError("Add at least one keyword.");
      return;
    }
    triggerRun({
      keywords,
      ...(customProvider ? { provider: customProvider } : {}),
    });
  }

  const buttonsDisabled = isPending || isRunning;

  return (
    <div className="space-y-5">
      <RunControls
        isPending={isPending}
        isRunning={isRunning}
        disabled={buttonsDisabled}
        onRunConfigured={runConfigured}
        onToggleCustom={() => setCustomOpen((v) => !v)}
        customOpen={customOpen}
      />

      {customOpen && (
        <section className="surface p-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-ink">Custom run</h2>
            <p className="mt-0.5 text-xs text-mid">
              Override the configured list for a one-off scan. One keyword per
              line (or comma-separated). Findings still land in the KB and the
              combined report replaces the latest stored report.
            </p>
          </div>
          <textarea
            value={customKeywords}
            onChange={(e) => setCustomKeywords(e.target.value)}
            placeholder={"zero-knowledge proofs\nAleo network\nAlgorand DeFi"}
            rows={4}
            className="field w-full"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-xs text-mid">Provider</label>
            <select
              value={customProvider}
              onChange={(e) =>
                setCustomProvider(e.target.value as ResearchSearchProvider | "")
              }
              className="field field-sm"
            >
              <option value="">Use configured</option>
              {RESEARCH_SEARCH_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={runCustom}
              disabled={buttonsDisabled}
              className="btn btn-primary btn-sm ml-auto"
            >
              Run custom scan
            </button>
          </div>
        </section>
      )}

      {isRunning && (
        <RunningBanner
          runId={lastRunId}
          elapsedSec={elapsedSec}
          onCheckNow={() => router.refresh()}
        />
      )}

      {!isRunning && justCompletedAt && (
        <section
          className="surface p-4"
          style={{
            borderColor: "var(--success)",
            background: "var(--success-soft, var(--surface-2))",
          }}
        >
          <p className="text-sm text-ink">
            Scan complete.{" "}
            <span className="text-mid">
              Report updated{" "}
              {new Date(justCompletedAt).toLocaleTimeString()}.
            </span>
          </p>
        </section>
      )}

      {error && (
        <section
          className="surface p-4"
          style={{
            borderColor: "var(--danger)",
            background: "var(--danger-soft)",
          }}
        >
          <p className="text-sm text-danger">Error: {error}</p>
        </section>
      )}

      {report ? <Report report={report} /> : <EmptyState />}
    </div>
  );
}

function RunningBanner({
  runId,
  elapsedSec,
  onCheckNow,
}: {
  runId: string | null;
  elapsedSec: number;
  onCheckNow: () => void;
}) {
  const mm = Math.floor(elapsedSec / 60);
  const ss = elapsedSec % 60;
  const elapsed = `${mm}:${ss.toString().padStart(2, "0")}`;
  return (
    <section
      className="surface p-4"
      style={{
        borderColor: "var(--accent, var(--border-strong))",
        background: "var(--accent-soft, var(--surface-2))",
      }}
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <Spinner />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">
            Research scan running…{" "}
            <span className="text-mid">
              elapsed <code className="mono">{elapsed}</code>
              {runId && (
                <>
                  {" · "}
                  run id <code className="mono">{runId}</code>
                </>
              )}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-mid">
            Page auto-refreshes every {Math.round(POLL_INTERVAL_MS / 1000)}s
            until the new report arrives.
          </p>
        </div>
        <button
          type="button"
          onClick={onCheckNow}
          className="btn btn-secondary btn-sm shrink-0"
        >
          Check now
        </button>
      </div>
    </section>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--ink)]"
    />
  );
}

function RunControls({
  isPending,
  isRunning,
  disabled,
  onRunConfigured,
  onToggleCustom,
  customOpen,
}: {
  isPending: boolean;
  isRunning: boolean;
  disabled: boolean;
  onRunConfigured: () => void;
  onToggleCustom: () => void;
  customOpen: boolean;
}) {
  const primaryLabel = isRunning
    ? "Running…"
    : isPending
      ? "Starting…"
      : "Run now";
  return (
    <section className="surface p-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onRunConfigured}
        disabled={disabled}
        className="btn btn-primary btn-sm"
      >
        {primaryLabel}
      </button>
      <button
        type="button"
        onClick={onToggleCustom}
        disabled={disabled}
        className="btn btn-secondary btn-sm"
      >
        {customOpen ? "Close custom run" : "Custom run…"}
      </button>
      <span className="ml-auto text-xs text-mid">
        Daily cron: 07:45 Kathmandu (02:00 UTC)
      </span>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="surface p-6">
      <h2 className="text-base font-semibold text-ink">No report yet</h2>
      <p className="mt-1.5 text-sm text-mid max-w-prose">
        The daily research cron has not produced a report yet. Add at least one
        keyword in Settings → Research and hit{" "}
        <strong className="text-ink">Run now</strong> above, or wait for the
        daily 07:45 Kathmandu (02:00 UTC) scan.
      </p>
    </section>
  );
}

function Report({ report }: { report: ResearchReport }) {
  const successCount = report.results.filter((r) => r.status === "ok").length;
  const errorCount = report.results.filter((r) => r.status === "error").length;
  const skippedCount = report.results.filter((r) => r.status === "skipped").length;

  return (
    <>
      <section className="surface p-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="badge badge-neutral">Date {report.date}</span>
          <span className="badge badge-neutral">Provider {report.provider}</span>
          <span className="badge badge-success badge-dot">
            {successCount} findings
          </span>
          {errorCount > 0 && (
            <span className="badge badge-danger badge-dot">
              {errorCount} failed
            </span>
          )}
          {skippedCount > 0 && (
            <span className="badge badge-neutral">{skippedCount} skipped</span>
          )}
          <span className="ml-auto text-xs text-mid">
            Generated {new Date(report.generatedAt).toLocaleString()}
          </span>
        </div>

        {report.results.length > 1 && (
          <nav className="mt-4 flex flex-wrap gap-1.5">
            {report.results.map((r) => (
              <a
                key={r.keyword}
                href={`#kw-${slugify(r.keyword)}`}
                className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-surface-2 px-2 py-1 text-[12px] text-ink hover:border-[var(--border-strong)] transition-colors"
              >
                <StatusDot status={r.status} />
                {r.keyword}
              </a>
            ))}
          </nav>
        )}
      </section>

      {report.results.map((r) => (
        <section
          key={r.keyword}
          id={`kw-${slugify(r.keyword)}`}
          className="surface p-5 scroll-mt-4"
        >
          <header className="flex items-center justify-between gap-3 mb-4 pb-3 border-b border-[var(--border)]">
            <div className="flex items-center gap-2 min-w-0">
              <StatusDot status={r.status} />
              <h2 className="text-base font-semibold text-ink truncate">
                {r.keyword}
              </h2>
            </div>
            {r.status === "ok" ? (
              <span className="badge badge-success badge-dot">findings</span>
            ) : r.status === "error" ? (
              <span className="badge badge-danger badge-dot">error</span>
            ) : (
              <span className="badge badge-neutral">skipped</span>
            )}
          </header>
          {r.status === "error" ? (
            <ErrorBlock message={r.error ?? "Unknown error."} />
          ) : r.report?.trim() ? (
            <MarkdownContent source={r.report.trim()} />
          ) : (
            <p className="text-sm text-mid italic">(no findings)</p>
          )}
        </section>
      ))}
    </>
  );
}

function StatusDot({ status }: { status: "ok" | "skipped" | "error" }) {
  const color =
    status === "ok"
      ? "var(--success)"
      : status === "error"
        ? "var(--danger)"
        : "var(--text-faint)";
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
      style={{ background: color }}
    />
  );
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function ErrorBlock({ message }: { message: string }) {
  const parsed = extractFriendlyError(message);
  return (
    <div
      className="rounded-md border p-3.5 text-sm"
      style={{
        borderColor: "var(--danger)",
        background: "var(--danger-soft)",
      }}
    >
      <p className="font-medium text-danger">{parsed.summary}</p>
      {parsed.detail && (
        <p className="mt-1.5 text-[13px] text-mid leading-relaxed">
          {parsed.detail}
        </p>
      )}
      {parsed.raw && (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-faint hover:text-mid">
            Raw error
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface-2 p-2 text-[11.5px] text-mid mono whitespace-pre-wrap">
            {parsed.raw}
          </pre>
        </details>
      )}
    </div>
  );
}

function extractFriendlyError(message: string): {
  summary: string;
  detail?: string;
  raw?: string;
} {
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    const head = message.slice(0, jsonStart).trim().replace(/[:.\s]+$/, "");
    const tail = message.slice(jsonStart);
    try {
      const obj = JSON.parse(tail) as {
        error?: { message?: string; type?: string; code?: string };
      };
      const inner = obj.error?.message;
      if (inner) {
        return {
          summary: head || "Tool error",
          detail: inner,
          raw: message,
        };
      }
    } catch {
      // fall through
    }
  }
  return { summary: message };
}

function MarkdownContent({ source }: { source: string }) {
  return (
    <div
      className="md-content"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  );
}

// Lightweight markdown → HTML. Mirrors the renderer in app/blog/[slug]/page.tsx
// but adds link, blockquote, ordered list, and HTML escaping for safety.
function renderMarkdown(md: string): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // Pull out fenced code blocks first so their contents are not transformed.
  const codeBlocks: string[] = [];
  let src = md.replace(/```[\w-]*\n([\s\S]*?)```/g, (_m, body: string) => {
    codeBlocks.push(escape(body.replace(/\n$/, "")));
    return ` CODE${codeBlocks.length - 1} `;
  });

  src = escape(src);

  // Inline: code, bold, italic, link
  src = src
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
    )
    .replace(
      /(^|[\s(])(https?:\/\/[^\s)<]+)/g,
      '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>',
    );

  // Block-level: split by blank lines, then handle headings / lists / hr / blockquotes.
  const blocks = src.split(/\n\s*\n+/);
  const html = blocks
    .map((block) => {
      const lines = block.split("\n");

      if (/^\s*---\s*$/.test(block)) return "<hr />";

      const heading = block.match(/^(#{1,4})\s+(.+)$/);
      if (heading && lines.length === 1) {
        const level = heading[1]!.length;
        return `<h${level}>${heading[2]}</h${level}>`;
      }

      if (lines.every((l) => /^\s*>\s?/.test(l))) {
        const inner = lines.map((l) => l.replace(/^\s*>\s?/, "")).join("<br />");
        return `<blockquote>${inner}</blockquote>`;
      }

      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines
          .map((l) => `<li>${l.replace(/^\s*[-*]\s+/, "")}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }

      if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
        const items = lines
          .map((l) => `<li>${l.replace(/^\s*\d+\.\s+/, "")}</li>`)
          .join("");
        return `<ol>${items}</ol>`;
      }

      return `<p>${lines.join("<br />")}</p>`;
    })
    .join("\n");

  return html.replace(/ CODE(\d+) /g, (_m, i: string) => {
    return `<pre><code>${codeBlocks[Number(i)]}</code></pre>`;
  });
}
