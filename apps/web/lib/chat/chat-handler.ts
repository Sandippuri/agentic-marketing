// In-process chat entry point. Phase 3 of the Vercel migration. Mirrors
// apps/manager/src/chat-handler.ts but no longer requires the manager process:
//   - History persistence via getHistoryStore() (Redis or in-memory).
//   - Thread replies for web threads go to the in-process pub/sub bus
//     (apps/web/lib/chat/web-bus.ts) which the SSE route subscribes to.
//   - Slack/Discord delivery is intentionally out of scope (not used in prod;
//     §11 decision log). The reply callback is a no-op for non-web threads.
//
// Detached-workflow behaviour: as soon as the orchestrator invokes its first
// sub-agent, we reply with a tracking note and let the orchestrator finish in
// the background. Pure-conversation turns return inline.

import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import type { LlmModel, ThreadRef } from "@marketing/shared-types";
import { runOrchestrator } from "./orchestrator";
import { createGenerationTracker } from "./generation-tracker";
import { getHistoryStore, type ChatTurn } from "./history-store";
import { publishWebThreadEvent } from "./web-bus";

const log = pino({ name: "chat-handler" });

export type HandleChatParams = {
  text: string;
  userId: string;
  threadRef: ThreadRef;
  cp: CpClient;
  model?: LlmModel;
  /**
   * When set, the chat is scoped to a specific campaign: the orchestrator
   * receives a snapshot of the brief + content items as extra system context
   * so it can answer/edit without the user re-stating the campaign each turn.
   */
  campaignId?: string;
};

export async function handleChat(params: HandleChatParams): Promise<string> {
  const { text, userId, threadRef, cp, model, campaignId } = params;
  log.info({ userId, threadRef, text, model, campaignId }, "chat received");

  // Mode router: `/goal <body>` or `/goal:<json>` triggers the goal-loop
  // workflow instead of the per-turn orchestrator. Single-task, one-shot
  // workflow, lifecycle, and experiment modes share this same router.
  // See plan: Phase 2 Mode Router.
  const mode = parseModeFromMessage(text);
  if (mode.kind === "goal") {
    return await handleGoalMode({ ...params, parsed: mode });
  }

  const systemContext = campaignId
    ? await (await import("./campaign-context")).buildCampaignContext(campaignId)
    : undefined;

  const store = getHistoryStore();
  const history: ChatTurn[] = await store.get(threadRef);
  history.push({ role: "user", content: text });

  let firstStepResolve: ((jobId: string) => void) | null = null;
  const firstStep = new Promise<string>((res) => {
    firstStepResolve = res;
  });

  const tracker = createGenerationTracker({
    cp,
    threadRef,
    userId,
    userMessage: text,
    onFirstStep: (jobId) => firstStepResolve?.(jobId),
  });

  const orchestratorOutcome: Promise<
    { ok: true; text: string } | { ok: false; err: unknown }
  > = runOrchestrator({
    text,
    userId,
    threadRef,
    history,
    cp,
    model,
    tracker,
    systemContext,
  }).then(
    (out) => ({ ok: true as const, text: out }),
    (err) => ({ ok: false as const, err }),
  );

  const winner = await Promise.race([
    firstStep.then((jobId) => ({ kind: "workflow" as const, jobId })),
    orchestratorOutcome.then((outcome) => ({
      kind: "sync" as const,
      outcome,
    })),
  ]);

  if (winner.kind === "sync") {
    if (winner.outcome.ok) {
      history.push({ role: "assistant", content: winner.outcome.text });
      await store.set(threadRef, history);
      replyToThread(threadRef, winner.outcome.text);
      return winner.outcome.text;
    }
    log.error({ err: winner.outcome.err }, "orchestrator error (sync)");
    const fallback = "Something went wrong. Try again or check the admin UI.";
    replyToThread(threadRef, fallback);
    return fallback;
  }

  const startMessage =
    `Workflow started (job ${winner.jobId}). ` +
    `Track step-by-step progress at /creation-workflow. ` +
    `I'll post the result back here when it's ready.`;
  history.push({ role: "assistant", content: startMessage });
  await store.set(threadRef, history);
  replyToThread(threadRef, startMessage);

  void orchestratorOutcome.then(async (outcome) => {
    try {
      if (outcome.ok) {
        await tracker.complete();
        await appendAssistantTurn(threadRef, outcome.text);
        replyToThread(threadRef, outcome.text);
      } else {
        log.error({ err: outcome.err }, "orchestrator error (detached)");
        await tracker.fail(outcome.err);
        const errMessage =
          outcome.err instanceof Error ? outcome.err.message : "unknown error";
        const failureNote =
          `Workflow failed (job ${winner.jobId}): ${errMessage}. ` +
          `See /creation-workflow for the step that broke.`;
        await appendAssistantTurn(threadRef, failureNote);
        replyToThread(threadRef, failureNote);
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message },
        "background chat finalisation failed",
      );
    }
  });

  return startMessage;
}

function replyToThread(threadRef: ThreadRef, message: string): void {
  if (threadRef.startsWith("web:")) {
    publishWebThreadEvent(threadRef, { kind: "message", text: message });
  }
  // Slack/Discord delivery is intentionally not wired in Phase 3.
}

async function appendAssistantTurn(
  threadRef: string,
  content: string,
): Promise<void> {
  const store = getHistoryStore();
  const history = await store.get(threadRef);
  history.push({ role: "assistant", content });
  await store.set(threadRef, history);
}

// ============================================================
// Mode router
// ============================================================

type ParsedGoal = {
  kind: "goal";
  summary: string;
  // Reserved for future structured-arg parsing; today we just pass the raw
  // summary to the goal-loop.
};

type ParsedMode = ParsedGoal | { kind: "default" };

function parseModeFromMessage(text: string): ParsedMode {
  const trimmed = text.trim();
  // /goal <summary>
  const m = /^\/goal\s+(.+)$/is.exec(trimmed);
  if (m && m[1]) {
    return { kind: "goal", summary: m[1].trim() };
  }
  return { kind: "default" };
}

async function handleGoalMode(params: HandleChatParams & { parsed: ParsedGoal }): Promise<string> {
  const { threadRef, parsed } = params;
  // Hit the in-process API route through fetch so we share validation +
  // workflow start logic with the public surface.
  try {
    const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
    const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
    const res = await fetch(`${baseUrl}/api/goals`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": internalToken,
      },
      body: JSON.stringify({ summary: parsed.summary }),
    });
    if (!res.ok) {
      const reply = `Goal start failed: ${res.status} ${await res.text()}`;
      replyToThread(threadRef, reply);
      return reply;
    }
    const json = (await res.json()) as { campaignId: string; runId: string };
    const reply =
      `Goal accepted. Campaign ${json.campaignId.slice(0, 8)} created; ` +
      `goal-loop run ${json.runId.slice(0, 8)} started. ` +
      `Watch progress at /admin/campaigns/${json.campaignId} or /api/goals/${json.campaignId}.`;
    replyToThread(threadRef, reply);
    return reply;
  } catch (err) {
    const reply = `Goal start failed: ${(err as Error).message}`;
    replyToThread(threadRef, reply);
    return reply;
  }
}
