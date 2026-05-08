"use client";

import { useEffect, useRef, useState } from "react";
import { useSlashSuggest } from "./slash-suggest";

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "system"; text: string }
  | { id: string; role: "card"; card: WebApprovalCard };

type ModelEntry = { id: string; label: string; provider: string };
type ModelsResponse = {
  default: string | undefined;
  providerLabels: Record<string, string>;
  models: ModelEntry[];
};

type WebApprovalCard = {
  type: "approval_card";
  approvalId: string;
  contentId: string;
  title: string;
  contentType: string;
  stage: string;
  campaignName: string;
  rationale: string | null;
  preview: string;
  assetSignedUrl: string | null;
  videoSignedUrl: string | null;
  videoMimeType: string | null;
  videoDurationSec: number | null;
  requestedAt: string;
};

type Thread = {
  id: string;
  threadRef: string;
  label: string;
};

const SESSION_KEY = "test-chat:session-id";
const THREADS_KEY = "test-chat:threads";
const MODEL_KEY = "test-chat:model";

function loadOrMintSession(): string {
  const existing = window.localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  window.localStorage.setItem(SESSION_KEY, fresh);
  return fresh;
}

function loadThreads(): Thread[] {
  try {
    const raw = window.localStorage.getItem(THREADS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Thread[];
  } catch {
    return [];
  }
}

function saveThreads(threads: Thread[]) {
  window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
}

function mintThread(): Thread {
  const session = loadOrMintSession();
  const threadId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    id: crypto.randomUUID(),
    threadRef: `web:S${session}:T${threadId}`,
    label: `New chat — ${new Date().toLocaleTimeString()}`,
  };
}

// Loaded via next/dynamic with ssr: false from chat-client.tsx, so window /
// localStorage / crypto / EventSource are defined at the first render and
// lazy initializers can use them directly.
export default function ChatClientReady() {
  const [sessionId] = useState<string>(loadOrMintSession);
  const [threads, setThreads] = useState<Thread[]>(() => {
    const existing = loadThreads();
    if (existing.length > 0) return existing;
    const fresh = mintThread();
    saveThreads([fresh]);
    return [fresh];
  });
  const [activeId, setActiveId] = useState<string>(() => threads[0]!.id);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelsResponse | null>(null);
  const [model, setModel] = useState<string>(
    () => window.localStorage.getItem(MODEL_KEY) ?? "",
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeThread = threads.find((t) => t.id === activeId) ?? threads[0]!;

  // Load available models on mount, then pick a default if none stored.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/test-chat/models")
      .then((r) => r.json() as Promise<ModelsResponse>)
      .then((data) => {
        if (cancelled) return;
        setModelOptions(data);
        const stored = window.localStorage.getItem(MODEL_KEY);
        const valid = stored && data.models.some((m) => m.id === stored);
        const next = valid ? stored : (data.default ?? data.models[0]?.id ?? "");
        setModel(next);
        if (next) window.localStorage.setItem(MODEL_KEY, next);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, []);

  const onModelChange = (next: string) => {
    setModel(next);
    window.localStorage.setItem(MODEL_KEY, next);
  };

  const slash = useSlashSuggest({
    input,
    onPick: (text) => setInput(text),
  });

  // Subscribe to SSE for the active thread.
  useEffect(() => {
    const es = new EventSource(
      `/api/test-chat/stream?threadRef=${encodeURIComponent(activeThread.threadRef)}`,
    );
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as
          | { kind: "message"; text: string }
          | { kind: "approval_card"; card: WebApprovalCard };
        if (event.kind === "message") {
          setMessages((prev) => dedupeAppend(prev, {
            id: crypto.randomUUID(),
            role: "assistant",
            text: event.text,
          }));
        } else if (event.kind === "approval_card") {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "card", card: event.card },
          ]);
        }
      } catch {
        // ignore malformed
      }
    };
    return () => es.close();
  }, [activeThread.threadRef]);

  // Auto-scroll on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const newThread = () => {
    const fresh = mintThread();
    setThreads((prev) => {
      const next = [fresh, ...prev];
      saveThreads(next);
      return next;
    });
    setActiveId(fresh.id);
    setMessages([]);
  };

  const switchThread = (id: string) => {
    setActiveId(id);
    setMessages([
      { id: crypto.randomUUID(), role: "system", text: "— resumed —" },
    ]);
  };

  const renameIfNew = (id: string, firstUserText: string) => {
    setThreads((prev) => {
      const next = prev.map((t) =>
        t.id === id && t.label.startsWith("New chat")
          ? { ...t, label: firstUserText.slice(0, 40) }
          : t,
      );
      saveThreads(next);
      return next;
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text },
    ]);
    renameIfNew(activeThread.id, text);

    // Phase 1 of the Vercel migration: slash commands bypass the
    // manager-routed orchestrator and dispatch a workflow run directly.
    //   /workflow [channel] <prompt>   → single_post (channel defaults to linkedin)
    //   /campaign <prompt>             → campaign plan (strategist drafts brief + calendar)
    const campaignMatch = text.match(/^\/campaign\s+([\s\S]+)$/i);
    if (campaignMatch) {
      await sendWorkflow({ kind: "campaign", request: campaignMatch[1]! });
      setBusy(false);
      return;
    }
    const workflowMatch = text.match(/^\/workflow(?:\s+(\S+))?\s+([\s\S]+)$/i);
    if (workflowMatch) {
      await sendWorkflow({
        kind: "single_post",
        channel: workflowMatch[1] ?? "linkedin",
        request: workflowMatch[2]!,
      });
      setBusy(false);
      return;
    }

    try {
      const res = await fetch("/api/test-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          threadRef: activeThread.threadRef,
          sessionId,
          ...(model ? { model } : {}),
        }),
      });
      const body = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok || body.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            text: `Error: ${body.error ?? res.statusText}`,
          },
        ]);
        return;
      }
      if (body.reply) {
        setMessages((prev) => dedupeAppend(prev, {
          id: crypto.randomUUID(),
          role: "assistant",
          text: body.reply!,
        }));
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: `Network error: ${(err as Error).message}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const sendWorkflow = async (opts: {
    kind: "single_post" | "campaign";
    request: string;
    channel?: string;
  }) => {
    const VALID_CHANNELS = [
      "internal_blog",
      "linkedin",
      "x",
      "email_hubspot",
      "email_mailchimp",
    ];
    const channel =
      opts.kind === "single_post"
        ? VALID_CHANNELS.includes(opts.channel ?? "")
          ? opts.channel
          : "linkedin"
        : undefined;
    try {
      // Goes through the unified dispatcher so the run shows up on
      // /creation-workflow alongside picker-launched runs. Engine is
      // resolved server-side from settings.workflow_engine.
      const res = await fetch("/api/workflow-runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: opts.kind,
          request: opts.request,
          ...(channel ? { channel } : {}),
          threadRef: activeThread.threadRef,
          ...(model ? { model } : {}),
        }),
      });
      const body = (await res.json()) as {
        workflowRunId?: string;
        engineRunRef?: string;
        error?: string;
      };
      if (!res.ok || body.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            text: `Workflow error: ${body.error ?? res.statusText}`,
          },
        ]);
        return;
      }
      const runShort = body.workflowRunId?.slice(0, 8) ?? "?";
      const reply =
        opts.kind === "campaign"
          ? `Campaign workflow started (run=${runShort}).\n` +
            `Strategist is drafting a brief + content calendar. ` +
            `Watch progress on /creation-workflow.`
          : `Single-post workflow started (channel=${channel}, run=${runShort}).\n` +
            `Drafting + submitting for review now. Approve at /approvals — ` +
            `the workflow resumes automatically and runs the publish stub.\n` +
            `Watch progress on /creation-workflow.`;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", text: reply },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: `Network error: ${(err as Error).message}`,
        },
      ]);
    }
  };

  return (
    <div className="grid grid-cols-[220px_1fr] gap-4 flex-1 min-h-0">
      <Sidebar
        threads={threads}
        activeId={activeId}
        onNew={newThread}
        onSelect={switchThread}
      />
      <div className="flex flex-col min-h-0 rounded-xl border border-zinc-200 dark:border-zinc-800">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <p className="text-sm text-zinc-500">
              Start by asking the agent to plan a campaign, draft content, or
              push to test publish. Type <code className="text-xs">/</code> to
              see slash commands.
            </p>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
        </div>
        <div className="border-t border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
          <ModelPicker
            value={model}
            options={modelOptions}
            onChange={onModelChange}
            disabled={busy}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="relative flex gap-2"
          >
            {slash.popup}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (slash.handleKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={busy ? "thinking…" : "Type a message — Enter to send, Shift+Enter for newline"}
              disabled={busy}
              rows={2}
              className="flex-1 resize-none rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="self-end rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-400 text-white text-sm font-medium px-4 py-2"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// SSE echoes the synchronous reply post — drop a duplicate that matches the
// most recent assistant message so the user doesn't see the same line twice.
function dedupeAppend(prev: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (
    next.role === "assistant" &&
    last &&
    last.role === "assistant" &&
    last.text === next.text
  ) {
    return prev;
  }
  return [...prev, next];
}

function ModelPicker({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: ModelsResponse | null;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  if (!options) {
    return (
      <div className="text-xs text-zinc-500">Loading models…</div>
    );
  }
  if (options.models.length === 0) {
    return (
      <div className="text-xs text-amber-600 dark:text-amber-400">
        No model providers configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or
        GEMINI_API_KEY in apps/web/.env.local and restart.
      </div>
    );
  }
  // Group by provider while preserving the catalog order.
  const groups = new Map<string, ModelEntry[]>();
  for (const m of options.models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider)!.push(m);
  }
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
      <span>Model</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs"
      >
        {Array.from(groups.entries()).map(([provider, entries]) => (
          <optgroup key={provider} label={options.providerLabels[provider] ?? provider}>
            {entries.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function Sidebar({
  threads,
  activeId,
  onNew,
  onSelect,
}: {
  threads: Thread[];
  activeId: string;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="flex flex-col gap-2 min-h-0">
      <button
        onClick={onNew}
        className="rounded-lg bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 text-white text-sm font-medium px-3 py-2"
      >
        + New chat
      </button>
      <ul className="flex-1 overflow-y-auto space-y-1">
        {threads.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => onSelect(t.id)}
              className={`w-full text-left rounded-md px-2 py-1.5 text-xs ${
                t.id === activeId
                  ? "bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
              title={t.threadRef}
            >
              {t.label}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "system") {
    return (
      <div className="text-xs text-zinc-500 italic text-center">{message.text}</div>
    );
  }
  if (message.role === "card") {
    return <ApprovalCardView card={message.card} />;
  }
  const align = message.role === "user" ? "items-end" : "items-start";
  const bubble =
    message.role === "user"
      ? "bg-indigo-600 text-white"
      : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100";
  return (
    <div className={`flex flex-col ${align}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${bubble}`}
      >
        {message.text}
      </div>
    </div>
  );
}

function ApprovalCardView({ card }: { card: WebApprovalCard }) {
  const [decided, setDecided] = useState<null | "approved" | "changes_requested" | "rejected">(null);
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (
    decision: "approved" | "changes_requested" | "rejected",
    body?: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${card.approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision,
          ...(body ? { reason: body } : {}),
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? res.statusText);
      }
      setDecided(decision);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 max-w-[85%]">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
          📋 {card.title}
        </h3>
        <span className="text-xs text-zinc-500">{card.contentType} · {card.stage}</span>
      </div>
      <div className="text-xs text-zinc-500 mb-3">{card.campaignName}</div>
      {card.rationale && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-3 py-2 mb-3 text-xs text-amber-900 dark:text-amber-200">
          <span className="font-medium">🧠 AI rationale:</span> {card.rationale}
        </div>
      )}
      {card.assetSignedUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.assetSignedUrl}
          alt="Asset preview"
          className="rounded-md mb-3 max-h-64 object-cover"
        />
      )}
      {card.videoSignedUrl && (
        <video
          src={card.videoSignedUrl}
          controls
          preload="metadata"
          className="rounded-md mb-3 max-h-64 w-full bg-black"
        >
          <track kind="captions" />
        </video>
      )}
      <div className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap mb-3">
        {card.preview}
      </div>
      {decided ? (
        <div className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          {decided === "approved" && "✅ Approved"}
          {decided === "changes_requested" && "✏️ Changes requested"}
          {decided === "rejected" && "❌ Rejected"}
        </div>
      ) : showReason ? (
        <div className="space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What needs to change? Be specific — the Content agent will read this."
            rows={3}
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={() => decide("changes_requested", reason)}
              disabled={busy || !reason.trim()}
              className="rounded-md bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-400 text-white text-sm font-medium px-3 py-1.5"
            >
              Send
            </button>
            <button
              onClick={() => setShowReason(false)}
              disabled={busy}
              className="rounded-md text-sm text-zinc-600 dark:text-zinc-400 px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => decide("approved")}
            disabled={busy}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-400 text-white text-sm font-medium px-3 py-1.5"
          >
            ✅ Approve
          </button>
          <button
            onClick={() => setShowReason(true)}
            disabled={busy}
            className="rounded-md bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-400 text-white text-sm font-medium px-3 py-1.5"
          >
            ✏️ Request changes
          </button>
          <button
            onClick={() => decide("rejected")}
            disabled={busy}
            className="rounded-md bg-rose-600 hover:bg-rose-500 disabled:bg-zinc-400 text-white text-sm font-medium px-3 py-1.5"
          >
            ❌ Reject
          </button>
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}
    </div>
  );
}
