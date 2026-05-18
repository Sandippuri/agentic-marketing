"use client";

import { useState } from "react";
import {
  WORKFLOW_MEDIA,
  type WorkflowMedia,
} from "@marketing/shared-types";

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
  instagram: "instagram",
  facebook: "facebook",
};

const MEDIA_LABEL: Record<WorkflowMedia, string> = {
  auto: "Auto",
  image: "Image",
  video: "Video",
  both: "Both",
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
  // Per-item media pick. Local state so each row in the calendar can choose
  // independently. Defaults to "auto" — legacy behavior.
  const [media, setMedia] = useState<WorkflowMedia>("auto");

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
      const body: Record<string, unknown> = {
        kind: "single_post",
        request,
        channel,
        campaignId,
      };
      if (media !== "auto") body.media = media;
      const res = await fetch("/api/workflow-runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? res.statusText);
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
    <span className="inline-flex items-center gap-1">
      {/* Media picker rides alongside Draft so the user makes the choice
          before kickoff. Server enforces feasibility (GEMINI_API_KEY,
          settings.video_generation_enabled) and 400s with a readable
          reason; we surface that in the button's error state. */}
      <select
        value={media}
        onChange={(e) => setMedia(e.target.value as WorkflowMedia)}
        disabled={state === "starting"}
        title="Media for this draft"
        className="field py-0.5 text-xs w-auto"
      >
        {WORKFLOW_MEDIA.map((m) => (
          <option key={m} value={m}>
            {MEDIA_LABEL[m]}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onDraft}
        disabled={state === "starting"}
        className="btn btn-secondary btn-xs"
      >
        {state === "starting" ? "Starting…" : "Draft"}
      </button>
    </span>
  );
}
