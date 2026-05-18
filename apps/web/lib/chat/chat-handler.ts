// In-process chat entry point. Phase 3 of the Vercel migration. Mirrors
// apps/manager/src/chat-handler.ts but no longer requires the manager process:
//   - History persistence via getHistoryStore() (Redis or in-memory).
//   - Thread replies for web threads go to the in-process pub/sub bus
//     (apps/web/lib/chat/web-bus.ts) which the SSE route subscribes to.
//   - Slack/Discord delivery is intentionally out of scope (not used in prod;
//     §11 decision log). The reply callback is a no-op for non-web threads.
//
// Detached-workflow behaviour: when the orchestrator calls dispatch_workflow
// and the workflow engine returns a real workflow_runs id, we reply with an
// honest tracking note ("Workflow run started (wrun_…)") and let the
// orchestrator finish in the background. In-process sub-agent work (strategist
// draft, content draft, etc.) streams back inline — we do NOT pretend that
// a workflow ran when none did.

import pino from "pino";
import type { Message } from "ai";
import type { CpClient } from "@marketing/cp-client";
import type { LlmModel, ThreadRef } from "@marketing/shared-types";
import {
  runOrchestrator,
  streamOrchestrator,
  streamOrchestratorUi,
} from "./orchestrator";
import { createGenerationTracker } from "./generation-tracker";
import {
  getHistoryStore,
  getUiHistoryStore,
  type ChatTurn,
} from "./history-store";
import { publishWebThreadEvent } from "./web-bus";
import { learnFromConversation } from "./learn-from-conversation";
import { buildThreadAttachmentsContext } from "./thread-attachments";

const log = pino({ name: "chat-handler" });

export type HandleChatParams = {
  text: string;
  userId: string;
  /** Workspace this chat operates against. PR 4: mandatory. */
  workspaceId: string;
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
  const { text, userId, workspaceId, threadRef, cp, model, campaignId } = params;
  log.info({ userId, threadRef, text, model, campaignId }, "chat received");

  // Mode router: `/goal <body>` or `/goal:<json>` triggers the goal-loop
  // workflow instead of the per-turn orchestrator. Single-task, one-shot
  // workflow, lifecycle, and experiment modes share this same router.
  // See plan: Phase 2 Mode Router.
  const mode = parseModeFromMessage(text);
  if (mode.kind === "goal") {
    return await handleGoalMode({ ...params, parsed: mode });
  }

  const systemContext = await buildChatSystemContext({
    workspaceId,
    threadRef,
    campaignId,
  });

  const store = getHistoryStore();
  const history: ChatTurn[] = await store.get(threadRef);
  history.push({ role: "user", content: text });

  let dispatchResolve: ((workflowRunId: string) => void) | null = null;
  const workflowDispatched = new Promise<string>((res) => {
    dispatchResolve = res;
  });

  const tracker = createGenerationTracker({
    cp,
    threadRef,
    userId,
    userMessage: text,
    onWorkflowDispatched: (workflowRunId) => dispatchResolve?.(workflowRunId),
  });

  const orchestratorOutcome: Promise<
    { ok: true; text: string } | { ok: false; err: unknown }
  > = runOrchestrator({
    text,
    userId,
    workspaceId,
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
    workflowDispatched.then((workflowRunId) => ({
      kind: "workflow" as const,
      workflowRunId,
    })),
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
      learnFromConversation({
        threadRef,
        userId,
        workspaceId,
        userMessage: text,
        assistantMessage: winner.outcome.text,
        history,
      });
      return winner.outcome.text;
    }
    log.error({ err: winner.outcome.err }, "orchestrator error (sync)");
    const fallback = "Something went wrong. Try again or check the admin UI.";
    replyToThread(threadRef, fallback);
    return fallback;
  }

  const startMessage = buildDispatchStartMessage(winner.workflowRunId);
  history.push({ role: "assistant", content: startMessage });
  await store.set(threadRef, history);
  replyToThread(threadRef, startMessage);

  void orchestratorOutcome.then(async (outcome) => {
    try {
      if (outcome.ok) {
        await tracker.complete();
        await appendAssistantTurn(threadRef, outcome.text);
        replyToThread(threadRef, outcome.text);
        const finalHistory = await getHistoryStore().get(threadRef);
        learnFromConversation({
          threadRef,
          userId,
          workspaceId,
          userMessage: text,
          assistantMessage: outcome.text,
          history: finalHistory,
        });
      } else {
        log.error({ err: outcome.err }, "orchestrator error (detached)");
        await tracker.fail(outcome.err);
        const errMessage =
          outcome.err instanceof Error ? outcome.err.message : "unknown error";
        const failureNote =
          `Workflow run ${winner.workflowRunId} failed: ${errMessage}. ` +
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

export type ChatStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "workflow_started"; workflowRunId: string; message: string }
  | { kind: "done"; finalText: string }
  | { kind: "error"; message: string };

export type HandleChatStreamParams = HandleChatParams & {
  onEvent: (event: ChatStreamEvent) => void;
};

/**
 * Streaming variant of `handleChat`. Same detach semantics: if the
 * orchestrator calls `dispatch_workflow` and a workflow_runs row is created,
 * we emit `workflow_started` with the real workflowRunId and let the
 * orchestrator run on in the background — its final result will reach the
 * client via the SSE thread bus once ready.
 *
 * The `/goal` mode router falls through to the non-streaming `handleChat`
 * because its work is a single POST + immediate stub reply, with nothing
 * to stream.
 */
export async function handleChatStream(
  params: HandleChatStreamParams,
): Promise<void> {
  const { text, userId, workspaceId, threadRef, cp, model, campaignId, onEvent } = params;
  log.info({ userId, threadRef, text, model, campaignId }, "chat stream received");

  const mode = parseModeFromMessage(text);
  if (mode.kind === "goal") {
    const reply = await handleGoalMode({ ...params, parsed: mode });
    onEvent({ kind: "delta", text: reply });
    onEvent({ kind: "done", finalText: reply });
    return;
  }

  const systemContext = await buildChatSystemContext({
    workspaceId,
    threadRef,
    campaignId,
  });

  const store = getHistoryStore();
  const history: ChatTurn[] = await store.get(threadRef);
  history.push({ role: "user", content: text });

  let dispatchResolve: ((workflowRunId: string) => void) | null = null;
  const workflowDispatched = new Promise<string>((res) => {
    dispatchResolve = res;
  });

  const tracker = createGenerationTracker({
    cp,
    threadRef,
    userId,
    userMessage: text,
    onWorkflowDispatched: (workflowRunId) => dispatchResolve?.(workflowRunId),
  });

  // Once detach fires we stop forwarding deltas — the client switches into
  // workflow-tracking mode and the orchestrator's final answer will arrive
  // over the thread SSE bus.
  let detached = false;

  const orchestratorOutcome: Promise<
    { ok: true; text: string } | { ok: false; err: unknown }
  > = streamOrchestrator(
    {
      text,
      userId,
      workspaceId,
      threadRef,
      history,
      cp,
      model,
      tracker,
      systemContext,
    },
    {
      onDelta: (delta) => {
        if (detached) return;
        onEvent({ kind: "delta", text: delta });
      },
    },
  ).then(
    (out) => ({ ok: true as const, text: out }),
    (err) => ({ ok: false as const, err }),
  );

  const winner = await Promise.race([
    workflowDispatched.then((workflowRunId) => ({
      kind: "workflow" as const,
      workflowRunId,
    })),
    orchestratorOutcome.then((outcome) => ({
      kind: "sync" as const,
      outcome,
    })),
  ]);

  if (winner.kind === "sync") {
    if (winner.outcome.ok) {
      history.push({ role: "assistant", content: winner.outcome.text });
      await store.set(threadRef, history);
      // Skip the SSE thread-bus echo — the streaming client already has the
      // full text. Other subscribers to this thread are out of scope for the
      // test-chat UI.
      learnFromConversation({
        threadRef,
        userId,
        workspaceId,
        userMessage: text,
        assistantMessage: winner.outcome.text,
        history,
      });
      onEvent({ kind: "done", finalText: winner.outcome.text });
      return;
    }
    log.error({ err: winner.outcome.err }, "orchestrator error (stream sync)");
    onEvent({
      kind: "error",
      message: "Something went wrong. Try again or check the admin UI.",
    });
    return;
  }

  detached = true;
  const startMessage = buildDispatchStartMessage(winner.workflowRunId);
  history.push({ role: "assistant", content: startMessage });
  await store.set(threadRef, history);
  onEvent({
    kind: "workflow_started",
    workflowRunId: winner.workflowRunId,
    message: startMessage,
  });

  // Mirror the sync handler: replyToThread so other subscribers see the stub,
  // then finalize the background outcome onto the thread SSE bus.
  replyToThread(threadRef, startMessage);

  void orchestratorOutcome.then(async (outcome) => {
    try {
      if (outcome.ok) {
        await tracker.complete();
        await appendAssistantTurn(threadRef, outcome.text);
        replyToThread(threadRef, outcome.text);
        const finalHistory = await getHistoryStore().get(threadRef);
        learnFromConversation({
          threadRef,
          userId,
          workspaceId,
          userMessage: text,
          assistantMessage: outcome.text,
          history: finalHistory,
        });
      } else {
        log.error({ err: outcome.err }, "orchestrator error (stream detached)");
        await tracker.fail(outcome.err);
        const errMessage =
          outcome.err instanceof Error ? outcome.err.message : "unknown error";
        const failureNote =
          `Workflow run ${winner.workflowRunId} failed: ${errMessage}. ` +
          `See /creation-workflow for the step that broke.`;
        await appendAssistantTurn(threadRef, failureNote);
        replyToThread(threadRef, failureNote);
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message },
        "background stream chat finalisation failed",
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// useChat-driven streaming (Assistant page)
//
// The new handler accepts `messages: Message[]` from the AI SDK's useChat
// instead of a single `text` field. It returns the AI SDK data stream
// response that useChat consumes natively (tool-invocation parts and all).
//
// Persistence: on stream finish, the merged UIMessage[] is written to the
// UI history store (parallel to the legacy ChatTurn[] store). Refresh
// rehydrates via /api/test-chat/history?threadRef=…&format=ui.
//
// Workflow detach is no longer special-cased — the tool-invocation part for
// `dispatch_workflow` IS the user-facing signal that a long-running job
// kicked off. The catalog's renderer for that tool surfaces the run id and
// tracking link.
// ─────────────────────────────────────────────────────────────────────────

export type HandleChatUiStreamParams = {
  messages: Message[];
  userId: string;
  workspaceId: string;
  threadRef: ThreadRef;
  cp: CpClient;
  model?: LlmModel;
  campaignId?: string;
};

export async function handleChatUiStream(
  params: HandleChatUiStreamParams,
): Promise<Response> {
  const { messages, userId, workspaceId, threadRef, cp, model, campaignId } =
    params;
  log.info(
    { userId, threadRef, model, campaignId, msgCount: messages.length },
    "chat ui stream received",
  );

  const lastUserText = lastUserMessageText(messages);

  const systemContext = await buildChatSystemContext({
    workspaceId,
    threadRef,
    campaignId,
  });

  const tracker = createGenerationTracker({
    cp,
    threadRef,
    userId,
    userMessage: lastUserText ?? "",
    // The data-stream protocol surfaces dispatch_workflow as a tool-invocation
    // part — no need to detach the response stream early.
    onWorkflowDispatched: () => undefined,
  });

  return streamOrchestratorUi(
    {
      messages,
      userId,
      workspaceId,
      threadRef,
      cp,
      model,
      tracker,
      systemContext,
    },
    {
      onFinishMessages: async (merged) => {
        // Persist the full UIMessage[] for the Assistant page to rehydrate.
        await getUiHistoryStore().set(threadRef, merged);

        // Keep the legacy text-only mirror up to date too — campaign-context
        // and learnFromConversation still read from it. We flatten parts to
        // plain text per turn; tool-invocation parts are dropped (text is
        // what carries semantic meaning for those consumers).
        const flat = merged.map((m) => ({
          role: m.role === "user" ? ("user" as const) : ("assistant" as const),
          content: messageToText(m),
        }));
        await getHistoryStore().set(threadRef, flat);

        await tracker.complete().catch(() => undefined);

        const assistantText = flat
          .filter((m) => m.role === "assistant")
          .map((m) => m.content)
          .join("\n\n");
        if (lastUserText && assistantText) {
          learnFromConversation({
            threadRef,
            userId,
            workspaceId,
            userMessage: lastUserText,
            assistantMessage: assistantText,
            history: flat,
          });
        }
      },
    },
  );
}

function lastUserMessageText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    return messageToText(m);
  }
  return null;
}

function messageToText(m: Message): string {
  if (m.parts && m.parts.length > 0) {
    const texts = m.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text);
    if (texts.length > 0) return texts.join("\n").trim();
  }
  return (m.content ?? "").trim();
}

async function buildChatSystemContext(opts: {
  workspaceId: string;
  threadRef: ThreadRef;
  campaignId?: string;
}): Promise<string | undefined> {
  const { buildBaseMemory, buildVisualMemory } = await import(
    "@marketing/agents/memory"
  );
  const [brandMemory, visualMemory, campaignCtx, attachmentsCtx] = await Promise.all([
    buildBaseMemory({
      workspaceId: opts.workspaceId,
      campaignId: opts.campaignId,
    }),
    buildVisualMemory({
      workspaceId: opts.workspaceId,
      campaignId: opts.campaignId,
      includeTokens: true,
    }),
    opts.campaignId
      ? (await import("./campaign-context")).buildCampaignContext(
          opts.campaignId,
        )
      : Promise.resolve(undefined),
    buildThreadAttachmentsContext({
      workspaceId: opts.workspaceId,
      threadRef: opts.threadRef,
    }),
  ]);
  // Brand memory (voice / ICP / product / positioning / market) plus visual
  // identity (brand.visual prose + design tokens) goes first so the
  // orchestrator answers every turn with the business identity in its system
  // prompt, instead of having to call get_brand_memory() to find out who the
  // user is.
  const identityBody = [brandMemory, visualMemory]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
  const businessBlock = identityBody
    ? `# Business Context\n\nThe following defines who this workspace is — voice, ICP, product, positioning, market, visual identity. Apply it to every response unless the user overrides it.\n\n${identityBody}`
    : undefined;
  const parts = [businessBlock, campaignCtx, attachmentsCtx].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
}

function replyToThread(threadRef: ThreadRef, message: string): void {
  if (threadRef.startsWith("web:")) {
    publishWebThreadEvent(threadRef, { kind: "message", text: message });
  }
  // Slack/Discord delivery is intentionally not wired in Phase 3.
}

function buildDispatchStartMessage(workflowRunId: string): string {
  return (
    `Workflow run started (id ${workflowRunId}). ` +
    `Track step-by-step progress at /creation-workflow. ` +
    `I'll post the result back here when it's ready.`
  );
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
  const { threadRef, userId, workspaceId, text, parsed } = params;
  // Hit the in-process API route through fetch so we share validation +
  // workflow start logic with the public surface.
  const finish = async (reply: string) => {
    replyToThread(threadRef, reply);
    const store = getHistoryStore();
    const history = await store.get(threadRef);
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });
    await store.set(threadRef, history);
    learnFromConversation({
      threadRef,
      userId,
      workspaceId,
      userMessage: text,
      assistantMessage: reply,
      history,
    });
    return reply;
  };
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
      return finish(`Goal start failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { campaignId: string; runId: string };
    return finish(
      `Goal accepted. Campaign ${json.campaignId.slice(0, 8)} created; ` +
        `goal-loop run ${json.runId.slice(0, 8)} started. ` +
        `Watch progress at /admin/campaigns/${json.campaignId} or /api/goals/${json.campaignId}.`,
    );
  } catch (err) {
    return finish(`Goal start failed: ${(err as Error).message}`);
  }
}
