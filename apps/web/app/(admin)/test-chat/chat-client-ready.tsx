"use client";

// Assistant chat client — useChat-driven (AI SDK data stream protocol).
//
// Architecture:
//   - ChatClientReady (top-level): threads sidebar + active thread state +
//     attachments lifecycle + model picker. Hosts <ChatThread />.
//   - ChatThread (keyed on threadRef): owns the useChat hook. On thread
//     switch the component remounts (fresh state, fresh history fetch).
//     Renders messages by splitting into chunks and dispatching to
//     <ChatChunk />, plus the composer + slash menu.
//
// Tool calls and structured outputs (show_view / show_form) arrive as message
// `parts` from the AI SDK; chunks.ts → catalog.tsx handles rendering. Form
// submissions feed values back via `addToolResult`, and `maxSteps` makes
// useChat auto-resume so the model picks up the values on the next step.

import type { Message } from "ai";
import { useChat } from "ai/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSlashSuggest } from "./slash-suggest";
import { splitMessages, type FormField } from "./chunks";
import {
  ChatChunk,
  MessageActions,
  SUBSTEP_LABELS,
  TOOL_LABELS,
  type SubStepView,
} from "./catalog";
import { EmptyState } from "./empty-state";
import {
  loadApprovalCards,
  setApprovalDecision,
  upsertApprovalCard,
  type ApprovalDecision,
  type PersistedApprovalCard,
} from "./approval-cards-store";

type ModelEntry = { id: string; label: string; provider: string };
type ModelsResponse = {
  default: string | undefined;
  providerLabels: Record<string, string>;
  models: ModelEntry[];
};

// Wire-shape of approval cards arriving from the SSE bus. The persisted
// variant adds an optional decision stamp — see approval-cards-store.ts.
type WebApprovalCard = Omit<PersistedApprovalCard, "decision">;

type Thread = {
  id: string;
  threadRef: string;
  label: string;
  // ms-epoch timestamp. Threads predating this field load as 0 so they group
  // under "Earlier" instead of bunching everything into Today.
  createdAt: number;
};

type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  // Optional image fields — populated only when the server returns an inline
  // image preview URL. Doc uploads leave them undefined.
  kind?: "doc" | "image";
  imageUrl?: string;
};

const SESSION_KEY = "test-chat:session-id";
const THREADS_KEY = "test-chat:threads";
const MODEL_KEY = "test-chat:model";
const ATTACH_ACCEPT =
  "application/pdf,text/markdown,text/plain,image/jpeg,image/png,image/webp,.pdf,.md,.txt,.jpg,.jpeg,.png,.webp";
// Cap the local thread list so heavy users don't fill localStorage with
// stale chats. Oldest entries (by createdAt) get pruned on each save.
const THREADS_CAP = 50;

function attachmentKind(a: Attachment): "doc" | "image" {
  if (a.kind) return a.kind;
  return a.mimeType.startsWith("image/") ? "image" : "doc";
}

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
    const parsed = JSON.parse(raw) as Array<
      Thread | Omit<Thread, "createdAt">
    >;
    const normalized = parsed.map((t) => ({
      ...t,
      createdAt: typeof (t as Thread).createdAt === "number"
        ? (t as Thread).createdAt
        : 0,
    }));
    // One-shot migration for users who already have more than THREADS_CAP
    // entries from before the cap existed.
    return capThreads(normalized);
  } catch {
    return [];
  }
}

function saveThreads(threads: Thread[]) {
  window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
}

// Trim a thread list to THREADS_CAP, keeping the most-recently-created.
// Returns the same array reference when no work is needed so callers can
// cheaply check identity if they want to.
function capThreads(threads: Thread[]): Thread[] {
  if (threads.length <= THREADS_CAP) return threads;
  return [...threads]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, THREADS_CAP);
}

function mintThread(): Thread {
  const session = loadOrMintSession();
  const threadId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    id: crypto.randomUUID(),
    threadRef: `web:S${session}:T${threadId}`,
    label: "New chat",
    createdAt: Date.now(),
  };
}

// Loaded via next/dynamic with ssr: false from chat-client.tsx, so window /
// localStorage / crypto / EventSource are defined at the first render.
export default function ChatClientReady({
  displayName,
  workspaceName,
}: {
  displayName?: string | null;
  workspaceName?: string | null;
} = {}) {
  const [sessionId] = useState<string>(loadOrMintSession);
  // Threads minted in THIS browser session (i.e. they don't exist on the
  // server yet). Used to skip the history GET so + New chat doesn't briefly
  // flash "Loading conversation…" before showing the empty state.
  const freshThreadIdsRef = useRef<Set<string>>(new Set());
  const [threads, setThreads] = useState<Thread[]>(() => {
    const existing = loadThreads();
    if (existing.length > 0) return existing;
    const fresh = mintThread();
    freshThreadIdsRef.current.add(fresh.threadRef);
    saveThreads([fresh]);
    return [fresh];
  });
  const [activeId] = useState<string>(() => threads[0]!.id);
  const [modelOptions, setModelOptions] = useState<ModelsResponse | null>(null);
  const [model, setModel] = useState<string>(
    () => window.localStorage.getItem(MODEL_KEY) ?? "",
  );

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

  return (
    <div className="flex flex-col min-h-0 flex-1 rounded-xl border border-zinc-200 dark:border-zinc-800">
      <ChatThread
        key={activeThread.threadRef}
        threadRef={activeThread.threadRef}
        isFresh={freshThreadIdsRef.current.has(activeThread.threadRef)}
        sessionId={sessionId}
        model={model}
        modelOptions={modelOptions}
        onModelChange={onModelChange}
        displayName={displayName ?? null}
        workspaceName={workspaceName ?? null}
        onFirstUserMessage={(text) =>
          renameIfNew(activeThread.id, text)
        }
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ChatThread — owns useChat for a single thread
// ─────────────────────────────────────────────────────────────────────────

function ChatThread({
  threadRef,
  isFresh,
  sessionId,
  model,
  modelOptions,
  onModelChange,
  displayName,
  workspaceName,
  onFirstUserMessage,
}: {
  threadRef: string;
  // True when this thread was minted in the current browser session — no
  // server-side history exists, so we skip the GET and render immediately.
  isFresh: boolean;
  sessionId: string;
  model: string;
  modelOptions: ModelsResponse | null;
  onModelChange: (id: string) => void;
  displayName: string | null;
  workspaceName: string | null;
  onFirstUserMessage: (text: string) => void;
}) {
  const [historyReady, setHistoryReady] = useState(isFresh);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);

  // Fetch persisted UIMessage[] for this thread once, then mount useChat.
  // The component is keyed by threadRef in the parent so this only runs on
  // first mount per thread. Skipped entirely for session-minted threads.
  useEffect(() => {
    if (isFresh) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/test-chat/history?threadRef=${encodeURIComponent(threadRef)}&format=ui`,
        );
        if (!res.ok) {
          if (!cancelled) setHistoryReady(true);
          return;
        }
        const body = (await res.json()) as { messages?: Message[] };
        if (cancelled) return;
        setInitialMessages(body.messages ?? []);
        setHistoryReady(true);
      } catch {
        if (!cancelled) setHistoryReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadRef, isFresh]);

  if (!historyReady) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
        Loading conversation…
      </div>
    );
  }

  return (
    <ChatThreadInner
      threadRef={threadRef}
      sessionId={sessionId}
      model={model}
      modelOptions={modelOptions}
      onModelChange={onModelChange}
      displayName={displayName}
      workspaceName={workspaceName}
      initialMessages={initialMessages}
      onFirstUserMessage={onFirstUserMessage}
    />
  );
}

function ChatThreadInner({
  threadRef,
  sessionId,
  model,
  modelOptions,
  onModelChange,
  displayName,
  workspaceName,
  initialMessages,
  onFirstUserMessage,
}: {
  threadRef: string;
  sessionId: string;
  model: string;
  modelOptions: ModelsResponse | null;
  onModelChange: (id: string) => void;
  displayName: string | null;
  workspaceName: string | null;
  initialMessages: Message[];
  onFirstUserMessage: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const [systemNotes, setSystemNotes] = useState<
    Array<{ id: string; text: string }>
  >([]);
  const [approvalCards, setApprovalCards] = useState<PersistedApprovalCard[]>(
    () => loadApprovalCards(threadRef),
  );
  // Strategist (and future sub-agents') internal tool calls, grouped under
  // the parent run_strategist toolCallId. Updated by the SSE `sub_step` event
  // handler; consumed by ChatChunk to nest mini-rows under the parent chip.
  const [subStepsByCallId, setSubStepsByCallId] = useState<
    Record<string, SubStepView[]>
  >({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const firstUserSentRef = useRef(false);
  // Counter for drag enter/leave so nested children don't flicker the overlay.
  const dragCounterRef = useRef(0);

  const {
    messages,
    append,
    addToolResult,
    isLoading,
    stop,
    reload,
    setMessages,
    error,
  } = useChat({
    api: "/api/test-chat",
    id: threadRef,
    initialMessages,
    maxSteps: 5,
    streamProtocol: "data",
    experimental_prepareRequestBody: ({ messages: msgs }) => ({
      messages: msgs,
      threadRef,
      sessionId,
      ...(model ? { model } : {}),
    }),
    // Errors surface inline via the `error` helper + the banner below the
    // chunks list. No system note — they were noisy and easy to miss in the
    // scroll, and they didn't offer a retry.
  });

  // Rehydrate attachments on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/chat/attachments?threadRef=${encodeURIComponent(threadRef)}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as { attachments?: Attachment[] };
        if (!cancelled && body.attachments) setAttachments(body.attachments);
      } catch {
        // pills just won't show
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadRef]);

  // Subscribe to the SSE bus for cross-tab approval cards (other surfaces
  // post here; useChat's stream covers everything that originates in this
  // tab's conversation). Persisted card ids are pre-seeded so a server-side
  // replay can't double-render the same card.
  useEffect(() => {
    const es = new EventSource(
      `/api/test-chat/stream?threadRef=${encodeURIComponent(threadRef)}`,
    );
    const seenApprovalIds = new Set<string>(
      loadApprovalCards(threadRef).map((c) => c.approvalId),
    );
    const handleEvent = (raw: string) => {
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch (err) {
        // Treat malformed frames as observability events, not silent failures —
        // a flapping bus is something dev needs to see.
        console.warn(
          "[chat sse] malformed frame",
          (err as Error).message,
          raw.slice(0, 120),
        );
        return;
      }
      if (!isRecord(event) || typeof event.kind !== "string") {
        console.warn("[chat sse] frame missing 'kind'", event);
        return;
      }
      switch (event.kind) {
        case "approval_card": {
          const card = (event as { card?: WebApprovalCard }).card;
          if (!card || !card.approvalId) return;
          if (seenApprovalIds.has(card.approvalId)) return;
          seenApprovalIds.add(card.approvalId);
          setApprovalCards((prev) => upsertApprovalCard(threadRef, prev, card));
          return;
        }
        case "sub_step": {
          const s = (event as {
            step?: {
              parentToolCallId?: string;
              step?: string;
              state?: "call" | "result";
              at?: number;
            };
          }).step;
          if (
            !s ||
            typeof s.parentToolCallId !== "string" ||
            typeof s.step !== "string" ||
            (s.state !== "call" && s.state !== "result")
          ) {
            return;
          }
          const parent = s.parentToolCallId;
          const stepName = s.step;
          const state = s.state;
          const at = typeof s.at === "number" ? s.at : Date.now();
          setSubStepsByCallId((prev) => {
            const existing = prev[parent] ?? [];
            // Match a prior "call" for this step that hasn't resolved yet —
            // flipping it to "result" instead of appending so each sub-tool
            // shows as one row with an elapsed time, not two.
            if (state === "result") {
              const idx = (() => {
                for (let i = existing.length - 1; i >= 0; i -= 1) {
                  const e = existing[i];
                  if (e?.step === stepName && e.state === "call") return i;
                }
                return -1;
              })();
              if (idx >= 0) {
                const updated = [...existing];
                const prior = updated[idx]!;
                updated[idx] = { ...prior, state: "result", endedAt: at };
                return { ...prev, [parent]: updated };
              }
              // No matching "call" — rare race, just append a resolved row.
              return {
                ...prev,
                [parent]: [
                  ...existing,
                  { step: stepName, state: "result", startedAt: at, endedAt: at },
                ],
              };
            }
            return {
              ...prev,
              [parent]: [
                ...existing,
                { step: stepName, state: "call", startedAt: at },
              ],
            };
          });
          return;
        }
        case "message":
          // useChat's stream is the canonical source for assistant text in
          // this tab. The bus only echoes for cross-tab subscribers.
          return;
        default:
          // Unknown kind — log but don't crash. New event types can be added
          // server-side without forcing a client deploy.
          console.warn("[chat sse] unknown event kind", event.kind);
      }
    };
    es.onmessage = (ev) => handleEvent(ev.data);
    // The server emits an `event: open` named-event on connect. Older clients
    // ignored it (no listener for that channel); subscribe explicitly so we
    // surface connection state in logs.
    es.addEventListener("open", () => {
      // Native EventSource fires onopen too, but the SSE bus also emits a
      // payload-bearing 'open' event. Read either if useful.
    });
    es.onerror = () => {
      // The browser auto-reconnects on transient drops; nothing to do here
      // except surface it for debugging.
      console.warn("[chat sse] connection error / will retry");
    };
    return () => es.close();
  }, [threadRef]);

  // Keep the textarea fit-to-content even when input is changed externally
  // (e.g. cleared after send, or prefilled by an EmptyState chip).
  useEffect(() => {
    if (textareaRef.current) autosizeTextarea(textareaRef.current);
  }, [input]);

  // Auto-scroll when new content lands. Skip when the user has scrolled away
  // from the bottom so we don't yank them back mid-read.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages, isLoading, systemNotes, approvalCards]);

  const chunks = useMemo(() => splitMessages(messages), [messages]);
  const isEmpty = chunks.length === 0 && systemNotes.length === 0 && !isLoading;

  // Client-side 1 Hz tick to keep elapsed-time labels and the status
  // indicator alive during silent server periods (e.g. while the strategist
  // is busy and no stream deltas are arriving). Runs only while loading so
  // an idle thread doesn't re-render every second forever.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isLoading) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isLoading]);

  // First-seen / first-resolved timestamps per parent tool call. The stream
  // doesn't carry server-side timings for tool-invocation parts so we capture
  // them on the client the moment a chunk first appears. Recorded during
  // render via a ref — mutation here is fine and avoids an extra effect.
  const toolTimingsRef = useRef<
    Map<string, { startedAt: number; endedAt?: number }>
  >(new Map());
  for (const chunk of chunks) {
    if (chunk.kind !== "tool_call") continue;
    const existing = toolTimingsRef.current.get(chunk.toolCallId);
    if (!existing) {
      toolTimingsRef.current.set(chunk.toolCallId, { startedAt: Date.now() });
    } else if (chunk.state === "result" && existing.endedAt == null) {
      existing.endedAt = Date.now();
    }
  }

  // Live "what's the assistant doing right now" string. Powers both the
  // status bubble at the end of the message list and the textarea
  // placeholder so the user always has the same answer to "is it stuck?".
  const liveStatus = useMemo(() => {
    if (!isLoading) return null;
    // Most-recent in-flight tool call wins.
    let pending: Extract<typeof chunks[number], { kind: "tool_call" }> | null = null;
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const c = chunks[i];
      if (c && c.kind === "tool_call" && c.state !== "result") {
        pending = c;
        break;
      }
    }
    if (pending) {
      const t = toolTimingsRef.current.get(pending.toolCallId);
      const elapsed = t ? Math.max(0, nowMs - t.startedAt) : 0;
      const subs = subStepsByCallId[pending.toolCallId] ?? [];
      const lastInFlight = (() => {
        for (let i = subs.length - 1; i >= 0; i -= 1) {
          const s = subs[i];
          if (s && s.state === "call") return s;
        }
        return null;
      })();
      const toolLabel = TOOL_LABELS[pending.toolName] ?? pending.toolName;
      const subLabel = lastInFlight
        ? ` · ${SUBSTEP_LABELS[lastInFlight.step] ?? lastInFlight.step}`
        : "";
      return `${toolLabel}${subLabel} · ${formatElapsedShort(elapsed)}`;
    }
    // No pending tool: are we mid-stream on the final answer?
    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk && lastChunk.kind === "ai_text") return "Writing response…";
    return "Thinking…";
  }, [isLoading, chunks, nowMs, subStepsByCallId]);

  // Lookup for the actions row: text content per assistant messageId (so Copy
  // copies the prose, not the JSON of any tool calls) + the id of the very
  // last assistant message (the only one Regenerate should appear on).
  const { assistantTextById, lastAssistantId } = useMemo(() => {
    const map = new Map<string, string>();
    let last: string | null = null;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      last = m.id;
      const text = (m.parts ?? [])
        .filter(
          (p): p is { type: "text"; text: string } => p.type === "text",
        )
        .map((p) => p.text)
        .join("\n\n")
        .trim();
      map.set(m.id, text || m.content || "");
    }
    return { assistantTextById: map, lastAssistantId: last };
  }, [messages]);

  const slash = useSlashSuggest({
    input,
    onPick: (text) => setInput(text),
  });

  const send = async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    if (!firstUserSentRef.current) {
      onFirstUserMessage(text);
      firstUserSentRef.current = true;
    }

    // Slash dispatchers bypass the LLM (kept from the legacy contract). They
    // post a fake user message + assistant note to keep the timeline honest.
    const campaignMatch = text.match(/^\/campaign\s+([\s\S]+)$/i);
    const workflowMatch = !campaignMatch
      ? text.match(/^\/workflow(?:\s+(\S+))?\s+([\s\S]+)$/i)
      : null;
    if (campaignMatch) {
      const request = campaignMatch[1]!;
      await dispatchSlashWorkflow({
        userText: text,
        body: { kind: "campaign", request, threadRef, ...(model ? { model } : {}) },
        setMessages,
        append,
      });
      return;
    }
    if (workflowMatch) {
      const channel = VALID_CHANNELS.includes(workflowMatch[1] ?? "")
        ? workflowMatch[1]!
        : "linkedin";
      const request = workflowMatch[2]!;
      await dispatchSlashWorkflow({
        userText: text,
        body: {
          kind: "single_post",
          channel,
          request,
          threadRef,
          ...(model ? { model } : {}),
        },
        setMessages,
        append,
      });
      return;
    }

    await append({ role: "user", content: text });
  };

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("threadRef", threadRef);
      Array.from(fileList).forEach((f) => form.append("file", f));

      const res = await fetch("/api/chat/attachments", {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as {
        attachments?: Attachment[];
        error?: string;
        message?: string;
        filename?: string;
      };
      if (!res.ok || body.error) {
        setSystemNotes((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            text:
              `Upload failed${body.filename ? ` (${body.filename})` : ""}: ` +
              `${body.message ?? body.error ?? res.statusText}`,
          },
        ]);
        return;
      }
      if (body.attachments && body.attachments.length > 0) {
        setAttachments((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [
            ...prev,
            ...body.attachments!.filter((a) => !seen.has(a.id)),
          ];
        });
        setSystemNotes((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            text: `Attached: ${body.attachments!.map((a) => a.filename).join(", ")}. The assistant can read these on your next message.`,
          },
        ]);
      }
    } catch (err) {
      setSystemNotes((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          text: `Upload error: ${(err as Error).message}`,
        },
      ]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAttachment = async (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try {
      const res = await fetch(
        `/api/chat/attachments?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const refetched = await fetch(
          `/api/chat/attachments?threadRef=${encodeURIComponent(threadRef)}`,
        );
        if (refetched.ok) {
          const body = (await refetched.json()) as { attachments?: Attachment[] };
          if (body.attachments) setAttachments(body.attachments);
        }
      }
    } catch {
      // network blip — leave the optimistic removal in place
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragOver(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    void uploadFiles(e.dataTransfer.files);
  };

  return (
    <div
      className="relative flex flex-1 flex-col min-h-0"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-400 bg-indigo-50/85 dark:border-indigo-500 dark:bg-indigo-950/70">
          <div className="text-sm font-medium text-indigo-700 dark:text-indigo-200">
            Drop files to attach
          </div>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {isEmpty ? (
          <EmptyState
            displayName={displayName}
            workspaceName={workspaceName}
            onPrefill={(text) => {
              setInput(text);
            }}
          />
        ) : (
          <>
            {chunks.map((chunk, i) => {
              const nextChunk = chunks[i + 1];
              const isLastInMessage =
                !nextChunk || nextChunk.messageId !== chunk.messageId;
              const isAssistantChunk = chunk.kind !== "user_text";
              const showActions =
                isAssistantChunk &&
                isLastInMessage &&
                chunk.kind !== "suggestions" &&
                assistantTextById.has(chunk.messageId);
              const copyText =
                assistantTextById.get(chunk.messageId) ?? "";
              // Suggestion chips: only render them on the very last assistant
              // message so they don't pile up in the scroll.
              const showSuggestionsHere =
                chunk.messageId === lastAssistantId && !isLoading;
              return (
                <div key={chunk.key} className="space-y-1">
                  <ChatChunk
                    chunk={chunk}
                    onSubmitForm={(payload) => {
                      if (chunk.kind !== "form") return;
                      addToolResult({
                        toolCallId: chunk.toolCallId,
                        result: payload.values,
                      });
                    }}
                    onPickSuggestion={(text) =>
                      void append({ role: "user", content: text })
                    }
                    showSuggestions={showSuggestionsHere}
                    toolTiming={
                      chunk.kind === "tool_call"
                        ? toolTimingsRef.current.get(chunk.toolCallId)
                        : undefined
                    }
                    nowMs={isLoading ? nowMs : undefined}
                    subSteps={
                      chunk.kind === "tool_call"
                        ? subStepsByCallId[chunk.toolCallId]
                        : undefined
                    }
                  />
                  {showActions && copyText && (
                    <MessageActions
                      textToCopy={copyText}
                      showRegenerate={
                        chunk.messageId === lastAssistantId && !isLoading
                      }
                      onRegenerate={() => void reload()}
                    />
                  )}
                </div>
              );
            })}
            {systemNotes.map((n) => (
              <div
                key={n.id}
                className="text-xs italic text-zinc-500 text-center"
              >
                {n.text}
              </div>
            ))}
            {approvalCards.map((card) => (
              <ApprovalCardView
                key={card.approvalId}
                card={card}
                onDecided={(decision) =>
                  setApprovalCards((prev) =>
                    setApprovalDecision(
                      threadRef,
                      prev,
                      card.approvalId,
                      decision,
                    ),
                  )
                }
              />
            ))}
            {isLoading && <TypingIndicator status={liveStatus} />}
            {error && !isLoading && (
              <ErrorBanner
                message={error.message}
                onRetry={() => void reload()}
              />
            )}
          </>
        )}
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
        <ModelPicker
          value={model}
          options={modelOptions}
          onChange={onModelChange}
          disabled={isLoading}
        />
        {(attachments.length > 0 || uploading) && (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a) => {
              const kind = attachmentKind(a);
              return (
                <span
                  key={a.id}
                  title={`${a.filename} (${a.mimeType})`}
                  className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-200 pl-2 pr-1 py-0.5 text-xs"
                >
                  {kind === "image" && a.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.imageUrl}
                      alt=""
                      className="h-4 w-4 rounded object-cover"
                    />
                  ) : (
                    <span aria-hidden>{kind === "image" ? "🖼" : "📎"}</span>
                  )}
                  <span className="max-w-[180px] truncate">{a.filename}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.filename}`}
                    className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-indigo-500 hover:bg-indigo-100 hover:text-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-800 dark:hover:text-indigo-50"
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {uploading && (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 px-2 py-0.5 text-xs">
                <span aria-hidden>⏳</span> Uploading…
              </span>
            )}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="relative flex gap-2"
        >
          {slash.popup}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            className="hidden"
            onChange={(e) => void uploadFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || isLoading}
            title="Attach PDF, Markdown, or text file"
            className="self-end rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            📎
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autosizeTextarea(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (slash.handleKeyDown(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (let i = 0; i < items.length; i += 1) {
                const it = items[i];
                if (it?.kind !== "file") continue;
                const f = it.getAsFile();
                if (f) files.push(f);
              }
              if (files.length === 0) return;
              e.preventDefault();
              const dt = new DataTransfer();
              for (const f of files) dt.items.add(f);
              void uploadFiles(dt.files);
            }}
            placeholder={
              isLoading
                ? (liveStatus ?? "Thinking…")
                : attachments.length > 0
                  ? "Ask the assistant to read the attachments and plan…"
                  : "Type a message — Enter to send, Shift+Enter for newline"
            }
            disabled={isLoading}
            rows={2}
            className="flex-1 resize-none rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            style={{ maxHeight: "12rem" }}
          />
          {isLoading ? (
            <button
              type="button"
              onClick={() => stop()}
              className="self-end rounded-lg bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-900 dark:text-zinc-100 text-sm font-medium px-4 py-2"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="self-end rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-400 text-white text-sm font-medium px-4 py-2"
            >
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

// Resize the textarea to fit its content, capped by the CSS max-height. Cheap
// — fires on every keystroke. Setting height to 'auto' first lets scrollHeight
// shrink when the user deletes lines.
function autosizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (let i = 0; i < dt.items.length; i += 1) {
    if (dt.items[i]?.kind === "file") return true;
  }
  return dt.files.length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const VALID_CHANNELS = [
  "internal_blog",
  "linkedin",
  "x",
  "email_hubspot",
  "email_mailchimp",
];

async function dispatchSlashWorkflow(opts: {
  userText: string;
  body: Record<string, unknown>;
  setMessages: ReturnType<typeof useChat>["setMessages"];
  append: ReturnType<typeof useChat>["append"];
}): Promise<void> {
  await opts.append({ role: "user", content: opts.userText });
  try {
    const res = await fetch("/api/workflow-runs/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body),
    });
    const body = (await res.json()) as {
      workflowRunId?: string;
      engineRunRef?: string;
      error?: string;
    };
    if (!res.ok || body.error) {
      await opts.append({
        role: "assistant",
        content: `Workflow error: ${body.error ?? res.statusText}`,
      });
      return;
    }
    const runShort = body.workflowRunId?.slice(0, 8) ?? "?";
    const kind = (opts.body as { kind?: string }).kind;
    const channel = (opts.body as { channel?: string }).channel;
    const reply =
      kind === "campaign"
        ? `Campaign workflow started (run=${runShort}). Strategist is drafting a brief + content calendar. Watch progress on /creation-workflow.`
        : `Single-post workflow started (channel=${channel ?? "?"}, run=${runShort}). Drafting + submitting for review now. Approve at /approvals — the workflow resumes automatically and runs the publish stub. Watch progress on /creation-workflow.`;
    await opts.append({ role: "assistant", content: reply });
  } catch (err) {
    await opts.append({
      role: "assistant",
      content: `Network error: ${(err as Error).message}`,
    });
  }
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
    return <div className="text-xs text-zinc-500">Loading models…</div>;
  }
  if (options.models.length === 0) {
    return (
      <div className="text-xs text-amber-600 dark:text-amber-400">
        No model providers configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or
        GEMINI_API_KEY in apps/web/.env.local and restart.
      </div>
    );
  }
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
          <optgroup
            key={provider}
            label={options.providerLabels[provider] ?? provider}
          >
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

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
      <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-rose-200 text-rose-700 dark:bg-rose-900 dark:text-rose-200">
        !
      </span>
      <div className="flex-1">
        <div className="font-medium">Something went wrong</div>
        <div className="mt-0.5 text-rose-700 dark:text-rose-300">{message}</div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-md bg-rose-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-rose-500"
      >
        Retry
      </button>
    </div>
  );
}

function TypingIndicator({ status }: { status?: string | null }) {
  return (
    <div className="flex flex-col items-start">
      <div
        className="inline-flex items-center gap-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 px-3 py-2.5 text-sm"
        aria-label={status ? `Assistant: ${status}` : "Assistant is typing"}
      >
        <span className="inline-flex items-center gap-1">
          <span
            className="h-1.5 w-1.5 rounded-full bg-zinc-500 dark:bg-zinc-400 animate-bounce"
            style={{ animationDelay: "0ms", animationDuration: "1s" }}
          />
          <span
            className="h-1.5 w-1.5 rounded-full bg-zinc-500 dark:bg-zinc-400 animate-bounce"
            style={{ animationDelay: "150ms", animationDuration: "1s" }}
          />
          <span
            className="h-1.5 w-1.5 rounded-full bg-zinc-500 dark:bg-zinc-400 animate-bounce"
            style={{ animationDelay: "300ms", animationDuration: "1s" }}
          />
        </span>
        {status && (
          <span className="text-xs text-zinc-600 dark:text-zinc-300 tabular-nums">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

// Render-helper: compact ms / seconds formatter shared by ToolCallChip and
// the live status bubble. Keeps the two surfaces in sync (s precision under a
// minute, otherwise mm:ss). Defined here because it's also used by the
// composer placeholder.
function formatElapsedShort(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

// ─────────────────────────────────────────────────────────────────────────
// Approval card (cross-tab SSE — kept from the legacy client)
// ─────────────────────────────────────────────────────────────────────────

function ApprovalCardView({
  card,
  onDecided,
}: {
  card: PersistedApprovalCard;
  onDecided?: (decision: ApprovalDecision) => void;
}) {
  // Seeded from the persisted card so a refresh re-renders the same final
  // state instead of asking the user to decide again.
  const [decided, setDecided] = useState<null | ApprovalDecision>(
    card.decision ?? null,
  );
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (decision: ApprovalDecision, body?: string) => {
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
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? res.statusText);
      }
      setDecided(decision);
      onDecided?.(decision);
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
        <span className="text-xs text-zinc-500">
          {card.contentType} · {card.stage}
        </span>
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

// Suppress dead-code lint for the prop-typed FormField that callers may want
// to inspect when wiring a custom catalog entry. The type lives in chunks.ts
// and we re-export it here for ergonomic imports.
export type { FormField };
