"use client";

import { useEffect, useRef, useState } from "react";

type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "system"; text: string };

type Props = {
  campaignId: string;
  campaignName: string;
  fill?: boolean;
};

const SESSION_KEY = "test-chat:session-id";

function loadOrMintSession(): string {
  const existing = window.localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  window.localStorage.setItem(SESSION_KEY, fresh);
  return fresh;
}

export function CampaignChat({ campaignId, campaignName, fill = false }: Props) {
  const [mounted, setMounted] = useState(false);
  const [threadRef, setThreadRef] = useState<string>("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(fill);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const session = loadOrMintSession();
    setThreadRef(`web:campaign:${campaignId}:S${session}`);
    setMounted(true);
  }, [campaignId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  // SSE for detached workflow follow-ups: when the orchestrator hands off to
  // a long-running sub-agent, the API returns a "Workflow started" stub and
  // the actual answer arrives via the bus.
  useEffect(() => {
    if (!threadRef) return;
    const url = `/api/test-chat/stream?threadRef=${encodeURIComponent(threadRef)}`;
    const es = new EventSource(url);
    es.addEventListener("message", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          kind?: string;
          text?: string;
        };
        if (data.kind === "message" && data.text) {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", text: data.text! },
          ]);
        }
      } catch {
        // ignore malformed events
      }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => es.close();
  }, [threadRef]);

  async function send() {
    const text = input.trim();
    if (!text || busy || !threadRef) return;
    setInput("");
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text },
    ]);
    try {
      const res = await fetch("/api/test-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, threadRef, campaignId }),
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
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", text: body.reply! },
        ]);
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
  }

  if (!mounted) return null;

  return (
    <section
      className={`rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden ${
        fill ? "flex flex-col h-full" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors shrink-0"
      >
        <div className="flex flex-col text-left">
          <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
            Campaign chat
          </span>
          <span className="text-xs text-zinc-500">
            Scoped to {campaignName} · ask for edits, re-drafts, or questions about its posts
          </span>
        </div>
        <span className="text-xs text-zinc-500">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className={`flex flex-col ${fill ? "flex-1 min-h-0" : ""}`}>
          <div
            ref={scrollRef}
            className={`overflow-y-auto p-4 space-y-3 text-sm ${
              fill ? "flex-1 min-h-0" : "max-h-96"
            }`}
          >
            {messages.length === 0 ? (
              <p className="text-xs text-zinc-500">
                Start by asking something like: <em>“Rewrite the LinkedIn post titled X to be punchier”</em> or{" "}
                <em>“Why is the blog draft still in_review?”</em>
              </p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    m.role === "user"
                      ? "ml-auto max-w-[85%] rounded-lg bg-indigo-600 text-white px-3 py-2 whitespace-pre-wrap"
                      : m.role === "assistant"
                      ? "mr-auto max-w-[85%] rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 px-3 py-2 whitespace-pre-wrap"
                      : "mx-auto max-w-[85%] rounded-md border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-3 py-2 text-xs"
                  }
                >
                  {m.text}
                </div>
              ))
            )}
          </div>

          <div className="border-t border-zinc-200 dark:border-zinc-800 p-3 flex gap-2 shrink-0">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Message the campaign agent…"
              rows={2}
              className="flex-1 resize-none rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              className="self-end h-[38px] rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
