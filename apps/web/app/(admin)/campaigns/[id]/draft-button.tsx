"use client";

import { useState } from "react";

type Props = {
  campaignId: string;
  itemTitle: string;
  itemType: string;
  itemStage: string;
  briefSnippet: string;
};

// CONTENT_TYPES (calendar) → CHANNELS (workflow input).
const TYPE_TO_CHANNEL: Record<string, string> = {
  blog: "internal_blog",
  linkedin: "linkedin",
  x_thread: "x",
  x_post: "x",
  email: "email_hubspot",
};

type State = "idle" | "starting" | "started" | "error";

export function DraftCalendarItemButton({
  campaignId,
  itemTitle,
  itemType,
  itemStage,
  briefSnippet,
}: Props) {
  const [state, setState] = useState<State>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function onDraft() {
    if (state === "starting" || state === "started") return;
    setState("starting");
    setErrMsg(null);

    const channel = TYPE_TO_CHANNEL[itemType] ?? "linkedin";
    const request =
      `Draft a ${itemType} post for the calendar item titled "${itemTitle}" ` +
      `(stage: ${itemStage}).` +
      (briefSnippet ? `\n\nCampaign brief context:\n${briefSnippet}` : "");

    try {
      // Engine is resolved from settings.workflow_engine on the server.
      const res = await fetch("/api/workflow-runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "single_post",
          request,
          channel,
          campaignId,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) {
        throw new Error(body.error ?? res.statusText);
      }
      setState("started");
    } catch (err) {
      setState("error");
      setErrMsg((err as Error).message);
    }
  }

  if (state === "started") {
    return (
      <a
        href="/creation-workflow"
        className="text-xs text-[var(--success)] hover:underline inline-flex items-center gap-1"
      >
        Started
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 17L17 7M7 7h10v10" />
        </svg>
      </a>
    );
  }
  if (state === "error") {
    return (
      <button
        type="button"
        onClick={onDraft}
        title={errMsg ?? "Failed"}
        className="btn btn-danger btn-xs"
      >
        Retry
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onDraft}
      disabled={state === "starting"}
      className="btn btn-secondary btn-xs"
    >
      {state === "starting" ? "Starting…" : "Draft"}
    </button>
  );
}
