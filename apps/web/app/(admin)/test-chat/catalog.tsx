"use client";

// Component catalog for the chat mini-renderer plus higher-level chunk
// renderers (FormRenderer, ViewRenderer, ToolCallChip, ChatChunk).
//
// The `registry` object maps spec element types (FormShell / Input / Table /
// PlanCard / …) to React components. Adding a new view block kind = adding a
// new entry here and a corresponding case in `buildViewSpec`.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MiniRenderer,
  createStateStore,
  useStoreSnapshot,
  type Registry,
  type Spec,
} from "./mini-renderer";
import type { Chunk, FormField } from "./chunks";
import { Markdown } from "./markdown";

// ─────────────────────────────────────────────────────────────────────────
// Element catalog
// ─────────────────────────────────────────────────────────────────────────

const FormShell = ({
  title,
  renderChildren,
}: {
  title?: string;
  renderChildren?: () => ReactNode;
}) => (
  <form
    onSubmit={(e) => e.preventDefault()}
    className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
  >
    {title && (
      <h4 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h4>
    )}
    <div className="grid gap-2">{renderChildren?.()}</div>
  </form>
);

const Input = ({
  label,
  type = "text",
  value,
  onValueChange,
  placeholder,
  required,
}: {
  label: string;
  type?: string;
  value?: string | number;
  onValueChange?: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) => (
  <label className="grid gap-1 text-xs">
    <span className="text-zinc-600 dark:text-zinc-400">
      {label}
      {required && <span className="ml-0.5 text-rose-500">*</span>}
    </span>
    <input
      type={type}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onValueChange?.(e.target.value)}
      className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
    />
  </label>
);

const Textarea = ({
  label,
  value,
  onValueChange,
  placeholder,
  required,
}: {
  label: string;
  value?: string;
  onValueChange?: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) => (
  <label className="grid gap-1 text-xs">
    <span className="text-zinc-600 dark:text-zinc-400">
      {label}
      {required && <span className="ml-0.5 text-rose-500">*</span>}
    </span>
    <textarea
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onValueChange?.(e.target.value)}
      rows={3}
      className="resize-none rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
    />
  </label>
);

const Select = ({
  label,
  options = [],
  value,
  onValueChange,
  required,
}: {
  label: string;
  options?: string[];
  value?: string;
  onValueChange?: (v: string) => void;
  required?: boolean;
}) => (
  <label className="grid gap-1 text-xs">
    <span className="text-zinc-600 dark:text-zinc-400">
      {label}
      {required && <span className="ml-0.5 text-rose-500">*</span>}
    </span>
    <select
      value={value ?? ""}
      onChange={(e) => onValueChange?.(e.target.value)}
      className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
    >
      <option value="" disabled>
        Pick one…
      </option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  </label>
);

const SubmitButton = ({
  label,
  onPress,
}: {
  label: string;
  onPress?: () => void;
}) => (
  <button
    type="button"
    onClick={onPress}
    className="justify-self-start rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
  >
    {label}
  </button>
);

const ViewShell = ({
  title,
  renderChildren,
}: {
  title?: string;
  renderChildren?: () => ReactNode;
}) => (
  <div className="grid gap-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
    {title && (
      <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h4>
    )}
    <div className="grid gap-2">{renderChildren?.()}</div>
  </div>
);

const Heading = ({
  text,
  level = "h3",
}: {
  text: string;
  level?: "h3" | "h4";
}) => {
  const Tag = level;
  const cls =
    level === "h3"
      ? "text-base font-semibold text-zinc-900 dark:text-zinc-100"
      : "text-sm font-semibold text-zinc-800 dark:text-zinc-200";
  return <Tag className={cls}>{text}</Tag>;
};

const Text = ({
  text,
  intent,
}: {
  text: string;
  intent?: "info" | "success" | "warning";
}) => {
  const intentCls =
    intent === "success"
      ? "rounded-md bg-emerald-50 px-2 py-1 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
      : intent === "warning"
        ? "rounded-md bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        : intent === "info"
          ? "rounded-md bg-indigo-50 px-2 py-1 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200"
          : "text-zinc-700 dark:text-zinc-300";
  return <p className={`whitespace-pre-wrap text-sm ${intentCls}`}>{text}</p>;
};

const Table = ({
  columns = [],
  rows = [],
}: {
  columns?: string[];
  rows?: string[][];
}) => (
  <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
    <table className="w-full border-collapse text-xs">
      <thead className="bg-zinc-50 dark:bg-zinc-800/50">
        <tr>
          {columns.map((c) => (
            <th
              key={c}
              className="border-b border-zinc-200 px-2 py-1.5 text-left font-medium text-zinc-700 dark:border-zinc-800 dark:text-zinc-300"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="even:bg-zinc-50/40 dark:even:bg-zinc-800/20">
            {r.map((cell, j) => (
              <td
                key={j}
                className="border-b border-zinc-100 px-2 py-1.5 text-zinc-700 dark:border-zinc-800/60 dark:text-zinc-300"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const KeyValue = ({
  items = [],
}: {
  items?: Array<{ label: string; value: string }>;
}) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
    {items.map((it, i) => (
      <div key={i} className="contents">
        <dt className="text-zinc-500 dark:text-zinc-400">{it.label}</dt>
        <dd className="text-zinc-800 dark:text-zinc-100">{it.value}</dd>
      </div>
    ))}
  </dl>
);

type PlanWeek = {
  week: number;
  phase: string;
  summary: string;
  postCount?: number;
};

const PlanCard = ({ title, weeks = [] }: { title?: string; weeks?: PlanWeek[] }) => (
  <div className="grid gap-2">
    {title && (
      <div className="text-xs font-medium uppercase tracking-wide text-indigo-600 dark:text-indigo-300">
        {title}
      </div>
    )}
    <ol className="grid gap-1.5">
      {weeks.map((w) => (
        <li
          key={w.week}
          className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-2 dark:border-zinc-800 dark:bg-zinc-900/60"
        >
          <div className="flex shrink-0 flex-col items-center justify-center rounded-md bg-white px-2 py-1 text-center dark:bg-zinc-800">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Week
            </div>
            <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {w.week}
            </div>
          </div>
          <div className="flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-200">
                {w.phase}
              </span>
              {typeof w.postCount === "number" && (
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {w.postCount} post{w.postCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">
              {w.summary}
            </p>
          </div>
        </li>
      ))}
    </ol>
  </div>
);

export const registry: Registry = {
  FormShell: FormShell as Registry[string],
  Input: Input as Registry[string],
  Textarea: Textarea as Registry[string],
  Select: Select as Registry[string],
  SubmitButton: SubmitButton as Registry[string],
  ViewShell: ViewShell as Registry[string],
  Heading: Heading as Registry[string],
  Text: Text as Registry[string],
  Table: Table as Registry[string],
  KeyValue: KeyValue as Registry[string],
  PlanCard: PlanCard as Registry[string],
};

// ─────────────────────────────────────────────────────────────────────────
// Form renderer (with state store + submit dispatcher)
// ─────────────────────────────────────────────────────────────────────────

export type FormSubmitPayload = {
  form_id: string;
  title: string;
  fields: FormField[];
  values: Record<string, string | number>;
};

export function FormRenderer({
  spec,
  isSubmitted,
  onSubmit,
}: {
  spec: Spec;
  isSubmitted: boolean;
  onSubmit: (payload: FormSubmitPayload) => void;
}) {
  const store = useMemo(() => createStateStore({}), []);
  useStoreSnapshot(store);

  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  });

  const handlers = useMemo(
    () => ({
      submit_form: (params: Record<string, unknown>) => {
        const p = params as {
          form_id: string;
          title: string;
          fields: FormField[];
        };
        const snap = store.snapshot();
        const values: Record<string, string | number> = {};
        for (const f of p.fields) {
          const raw = snap[f.name];
          if (raw == null) continue;
          values[f.name] = f.type === "number" ? Number(raw) : String(raw);
        }
        onSubmitRef.current({
          form_id: p.form_id,
          title: p.title,
          fields: p.fields,
          values,
        });
      },
    }),
    [store],
  );

  return (
    <div className="relative">
      <MiniRenderer
        spec={spec}
        registry={registry}
        store={store}
        handlers={handlers}
      />
      {isSubmitted && (
        <div className="pointer-events-none absolute inset-0 rounded-xl bg-zinc-50/70 backdrop-blur-[1px] dark:bg-zinc-950/70">
          <div className="absolute right-2 top-2 rounded-full bg-emerald-500/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
            Submitted
          </div>
        </div>
      )}
    </div>
  );
}

export function ViewRenderer({ spec }: { spec: Spec }) {
  const store = useMemo(() => createStateStore({}), []);
  return (
    <MiniRenderer spec={spec} registry={registry} store={store} handlers={{}} />
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tool-call chip (any tool that isn't show_form / show_view)
// ─────────────────────────────────────────────────────────────────────────

export const TOOL_LABELS: Record<string, string> = {
  run_strategist: "Strategist",
  run_content: "Content",
  run_analyst: "Analyst",
  run_asset: "Asset",
  run_researcher: "Researcher",
  run_distributor: "Distributor",
  dispatch_workflow: "Workflow",
  kb_search: "KB search",
  kb_read_document: "KB read",
  kb_list: "KB list",
  kb_archive_attachment: "Archive to KB",
  attachment_read: "Read attachment",
  remember_insight: "Remember",
  list_campaigns: "Campaigns",
  check_publish_job: "Publish status",
  get_brand_memory: "Brand memory",
};

// Friendly labels for the strategist's internal tools. Surfaced as nested
// rows under the parent "Strategist" chip while the sub-agent is running so
// the user sees "Reading brand guidance · 1.2s" instead of a blank pulse.
export const SUBSTEP_LABELS: Record<string, string> = {
  read_memory: "Reading memory",
  read_past_learnings: "Reading past learnings",
  list_content: "Listing campaign content",
  find_brand_guidance: "Finding brand guidance",
  create_campaign: "Creating campaign",
  update_campaign: "Updating campaign",
  set_visual_identity: "Setting visual identity",
  find_similar_content: "Finding similar content",
  write_calendar: "Writing calendar",
};

export type SubStepView = {
  step: string;
  state: "call" | "result";
  startedAt: number;
  endedAt?: number;
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCallChip({
  toolName,
  args,
  state,
  result,
  startedAt,
  endedAt,
  nowMs,
  subSteps,
}: {
  toolName: string;
  args: Record<string, unknown>;
  state: "call" | "partial-call" | "result";
  result?: unknown;
  /** ms-epoch when the chip first appeared in the stream. */
  startedAt?: number;
  /** ms-epoch when the chip's state flipped to "result". Live ticks until then. */
  endedAt?: number;
  /** Shared ticker (1 Hz while loading) so all pending chips re-render together. */
  nowMs?: number;
  /** Nested progress emitted from inside the sub-agent (strategist today). */
  subSteps?: SubStepView[];
}) {
  const label = TOOL_LABELS[toolName] ?? toolName;
  const summary = summarizeArgs(args);
  const isPending = state !== "result";

  // dispatch_workflow's result includes a workflowRunId we want to surface
  // immediately so the user sees the tracking handle without waiting for the
  // assistant's follow-up text.
  const isDispatch = toolName === "dispatch_workflow";
  const dispatchInfo =
    isDispatch && state === "result" && isRecord(result)
      ? extractDispatch(result)
      : null;

  const elapsed = startedAt != null
    ? Math.max(0, (endedAt ?? nowMs ?? Date.now()) - startedAt)
    : null;

  return (
    <div className="inline-flex max-w-full flex-col items-start gap-1">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800/60">
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            isPending
              ? "animate-pulse bg-amber-500"
              : dispatchInfo
                ? "bg-emerald-500"
                : "bg-zinc-400"
          }`}
        />
        <span className="font-medium text-zinc-700 dark:text-zinc-200">{label}</span>
        {summary && (
          <span className="max-w-[260px] truncate text-zinc-500 dark:text-zinc-400">
            {summary}
          </span>
        )}
        {elapsed != null && (elapsed >= 100 || !isPending) && (
          <span className="tabular-nums text-[11px] text-zinc-400 dark:text-zinc-500">
            {formatElapsed(elapsed)}
          </span>
        )}
        {dispatchInfo && (
          <a
            href="/creation-workflow"
            className="font-medium text-emerald-700 hover:underline dark:text-emerald-300"
          >
            Track run {dispatchInfo.short}
          </a>
        )}
      </div>
      {subSteps && subSteps.length > 0 && (
        <ul className="ml-3 flex flex-col gap-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-700">
          {subSteps.map((s, i) => {
            const sLabel = SUBSTEP_LABELS[s.step] ?? s.step;
            const sElapsed = Math.max(
              0,
              (s.endedAt ?? nowMs ?? Date.now()) - s.startedAt,
            );
            const sPending = s.state !== "result";
            return (
              <li
                key={`${s.step}:${i}`}
                className="inline-flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400"
              >
                <span
                  aria-hidden
                  className={`inline-block h-1 w-1 rounded-full ${
                    sPending
                      ? "animate-pulse bg-amber-500"
                      : "bg-zinc-400"
                  }`}
                />
                <span>{sLabel}</span>
                <span className="tabular-nums text-zinc-400 dark:text-zinc-500">
                  {formatElapsed(sElapsed)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return "";
  const entries = Object.entries(args).slice(0, 2);
  return entries
    .map(([k, v]) => {
      if (typeof v === "string") return `${k}: ${v.length > 40 ? v.slice(0, 40) + "…" : v}`;
      if (typeof v === "number" || typeof v === "boolean") return `${k}: ${String(v)}`;
      return k;
    })
    .join(" · ");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractDispatch(
  result: Record<string, unknown>,
): { short: string } | null {
  const id = result.workflowRunId;
  if (typeof id !== "string" || id.length < 8) return null;
  return { short: id.slice(0, 8) };
}

// ─────────────────────────────────────────────────────────────────────────
// Submitted-form echo (read-only summary of values the user submitted)
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// MessageActions — Copy / Regenerate row, shown after the last chunk of an
// assistant message. Regenerate is only meaningful on the very last
// assistant turn (useChat.reload() re-runs that one).
// ─────────────────────────────────────────────────────────────────────────

export function MessageActions({
  textToCopy,
  showRegenerate,
  onRegenerate,
}: {
  textToCopy: string;
  showRegenerate: boolean;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — older browsers without clipboard API
    }
  };

  return (
    <div className="ml-1 mt-1 flex gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        title="Copy message"
      >
        <IconCopy />
        {copied ? "Copied" : "Copy"}
      </button>
      {showRegenerate && onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          title="Regenerate the last reply"
        >
          <IconRefresh />
          Regenerate
        </button>
      )}
    </div>
  );
}

function IconCopy() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

export function FormEcho({
  title,
  values,
}: {
  title: string;
  values: Record<string, string | number>;
}) {
  const items = Object.entries(values).map(([label, value]) => ({
    label,
    value: String(value),
  }));
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {title} · submitted
      </div>
      <KeyValue items={items} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ChatChunk — top-level dispatcher mapping `chunk.kind` to a component
// ─────────────────────────────────────────────────────────────────────────

export function ChatChunk({
  chunk,
  onSubmitForm,
  onPickSuggestion,
  showSuggestions = true,
  toolTiming,
  nowMs,
  subSteps,
}: {
  chunk: Chunk;
  onSubmitForm: (payload: FormSubmitPayload) => void;
  onPickSuggestion?: (text: string) => void;
  // Suggestion chips only make sense on the LAST assistant message. The
  // host sets this to false on older messages so the chips don't pile up
  // in the scroll.
  showSuggestions?: boolean;
  /** Per-toolCallId timing captured client-side (first-seen / first-resulted). */
  toolTiming?: { startedAt: number; endedAt?: number };
  /** Shared 1 Hz now-ms tick so pending chips update together. */
  nowMs?: number;
  /** Strategist-style internal steps surfaced from the SSE bus. */
  subSteps?: SubStepView[];
}) {
  if (chunk.kind === "user_text") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-indigo-600 px-3 py-2 text-sm text-white">
          {chunk.text}
        </div>
      </div>
    );
  }
  if (chunk.kind === "ai_text") {
    return (
      <div className="group flex flex-col items-start">
        <div className="max-w-[80%] rounded-2xl bg-zinc-100 px-3 py-2 text-sm text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
          <Markdown text={chunk.text} />
        </div>
      </div>
    );
  }
  if (chunk.kind === "ai_view") {
    return (
      <div className="flex justify-start">
        <div className="w-full max-w-[85%]">
          <ViewRenderer spec={chunk.spec} />
        </div>
      </div>
    );
  }
  if (chunk.kind === "form") {
    if (chunk.submitted && chunk.submittedValues) {
      return (
        <div className="flex justify-start">
          <div className="w-full max-w-[85%]">
            <FormEcho title={chunk.input.title} values={chunk.submittedValues} />
          </div>
        </div>
      );
    }
    const spec = buildClientFormSpec(chunk.input);
    return (
      <div className="flex justify-start">
        <div className="w-full max-w-[85%]">
          <FormRenderer
            spec={spec}
            isSubmitted={chunk.submitted}
            onSubmit={onSubmitForm}
          />
        </div>
      </div>
    );
  }
  if (chunk.kind === "tool_call") {
    return (
      <div className="flex justify-start">
        <ToolCallChip
          toolName={chunk.toolName}
          args={chunk.args}
          state={chunk.state}
          result={chunk.result}
          startedAt={toolTiming?.startedAt}
          endedAt={toolTiming?.endedAt}
          nowMs={nowMs}
          subSteps={subSteps}
        />
      </div>
    );
  }
  if (chunk.kind === "suggestions") {
    if (!showSuggestions || !onPickSuggestion) return null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {chunk.items.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onPickSuggestion(text)}
            className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/60 dark:hover:text-indigo-200"
          >
            {text}
          </button>
        ))}
      </div>
    );
  }
  return null;
}

// Mirror of apps/web/lib/chat/ui-tools.ts::buildFormSpec but client-side. The
// form input is also available on the server-side tool-call args, so the spec
// is rebuilt client-side rather than shipped over the wire to keep tool args
// small and avoid sending the same JSON twice.
function buildClientFormSpec(input: {
  form_id: string;
  title: string;
  fields: FormField[];
  submitLabel?: string;
}): Spec {
  const elements: Record<string, Spec["elements"][string]> = {};
  const fieldIds: string[] = [];
  for (const f of input.fields) {
    const id = `field_${f.name}`;
    fieldIds.push(id);
    elements[id] = {
      type:
        f.type === "textarea"
          ? "Textarea"
          : f.type === "select"
            ? "Select"
            : "Input",
      props: {
        label: f.label,
        name: f.name,
        ...(f.type === "select" || f.type === "textarea"
          ? {}
          : { type: f.type }),
        ...(f.options ? { options: f.options } : {}),
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
        ...(f.required ? { required: true } : {}),
        value: { $bindState: `/${f.name}` },
      },
    };
  }
  elements.submit_btn = {
    type: "SubmitButton",
    props: { label: input.submitLabel ?? "Submit" },
    on: {
      press: {
        action: "submit_form",
        params: {
          form_id: input.form_id,
          title: input.title,
          fields: input.fields,
        },
      },
    },
  };
  elements.form_root = {
    type: "FormShell",
    props: { title: input.title },
    children: [...fieldIds, "submit_btn"],
  };
  return { root: "form_root", elements };
}
