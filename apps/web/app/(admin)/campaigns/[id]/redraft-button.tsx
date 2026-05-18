"use client";

import { useState } from "react";

type Props = {
  campaignId: string;
  contentId: string;
  itemTitle: string;
  itemType: string;
};

// CONTENT_TYPES → CHANNELS (mirror of draft-button.tsx so the redraft
// dispatches into the same workflow path the original draft used).
const TYPE_TO_CHANNEL: Record<string, string> = {
  blog: "internal_blog",
  linkedin: "linkedin",
  x_thread: "x",
  x_post: "x",
  email: "email_hubspot",
  instagram: "instagram",
  facebook: "facebook",
};

type State = "idle" | "starting" | "started" | "error";

export function RedraftButton({
  campaignId,
  contentId,
  itemTitle,
  itemType,
}: Props) {
  const [state, setState] = useState<State>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function onRedraft() {
    if (state === "starting" || state === "started") return;
    setState("starting");
    setErrMsg(null);

    const channel = TYPE_TO_CHANNEL[itemType] ?? "linkedin";
    const request =
      `Redraft the existing ${itemType} post titled "${itemTitle}". ` +
      `Call get_revision_reason first to read the reviewer's latest changes_requested / rejected feedback, ` +
      `then call find_common_mistakes for the same topic, then call revise_content to update the body in place, ` +
      `and finally submit_for_review.`;

    try {
      // Engine is resolved from settings.workflow_engine on the server. If
      // the global engine can't revise in place (only Custom does today)
      // the API returns 400 and the user is asked to switch engines.
      const res = await fetch("/api/workflow-runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "single_post",
          request,
          channel,
          campaignId,
          contentId,
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
        Redrafting
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
        onClick={onRedraft}
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
      onClick={onRedraft}
      disabled={state === "starting"}
      className="btn btn-secondary btn-xs"
    >
      {state === "starting" ? "Starting…" : "Redraft"}
    </button>
  );
}
