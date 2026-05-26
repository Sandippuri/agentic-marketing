import {
  appendResponseMessages,
  convertToCoreMessages,
  generateText,
  streamText,
  tool,
  type CoreMessage,
  type Message,
} from "ai";
import { z } from "zod";
import pino from "pino";
import { eq } from "drizzle-orm";
import type { CpClient } from "@marketing/cp-client";
import {
  CHANNELS,
  WORKFLOW_MEDIA,
  resolveLlmModel,
  resolveResearchSearchProvider,
  type LlmModel,
  type ThreadRef,
} from "@marketing/shared-types";
import { getDb, schema } from "@marketing/db";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import { ORCHESTRATOR_PROMPT } from "@marketing/prompts";
import { getPrompt } from "@marketing/agents/prompt-store";
import { runStrategist } from "@marketing/agents/sub-agents/strategist";
import { runContent } from "@marketing/agents/sub-agents/content";
import { runAnalyst } from "@marketing/agents/sub-agents/analyst";
import { runAsset } from "@marketing/agents/sub-agents/asset";
import { runResearcher } from "@marketing/agents/sub-agents/researcher";
import { buildKbTools } from "@marketing/agents/tools/kb-tools";
import { ensureCollection, upsertDocument } from "@marketing/agents/kb";
import { chunkAndEmbed } from "@marketing/agents/kb";
import { buildWorkspaceTools } from "./workspace-tools";
import { buildAttachmentTools } from "./attachment-tools";
import { buildUiTools } from "./ui-tools";
import { buildKnowledgeContext } from "./knowledge-context";
import { publishWebThreadEvent } from "./web-bus";
import {
  dispatchStart,
  getDefaultWorkflowEngine,
  getDefaultWorkflowModel,
  getWorkflowModelConfig,
  pickSubAgentModel,
} from "@/lib/workflow-engines";
import { withSpan } from "./telemetry";
import type { GenerationTracker } from "./generation-tracker";

const log = pino({ name: "orchestrator" });

export type OrchestratorInput = {
  text: string;
  userId: string;
  /** Workspace scope; mandatory from PR 4. Resolved by the calling route. */
  workspaceId: string;
  threadRef: ThreadRef;
  history: Array<{ role: string; content: string }>;
  cp: CpClient;
  model?: LlmModel;
  tracker?: GenerationTracker;
  systemContext?: string;
};

export function runOrchestrator(input: OrchestratorInput): Promise<string> {
  return withSpan("orchestrator", { userId: input.userId, threadRef: input.threadRef }, () =>
    _runOrchestrator(input),
  );
}

async function buildOrchestratorCall({
  text,
  userId,
  workspaceId,
  threadRef,
  history,
  cp,
  model,
  tracker,
  systemContext,
}: OrchestratorInput) {
  const { workflowModel, subAgentModels } = await getWorkflowModelConfig();
  const resolvedModel = model ? resolveLlmModel(model) : workflowModel;
  const modelFor = (
    kind: "strategist" | "content" | "asset" | "analyst" | "researcher",
  ) =>
    pickSubAgentModel({
      kind,
      override: model,
      workflowModel,
      subAgentModels,
    });

  const researchProvider = await loadResearchProvider();
  log.info(
    { userId, threadRef, msgLen: text.length, model: resolvedModel, subAgentModels },
    "orchestrator start",
  );

  type StepName =
    | "strategist"
    | "content"
    | "asset"
    | "analyst"
    | "distributor"
    | "researcher";
  const recordStep = async <T>(
    name: StepName,
    input: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => (tracker ? tracker.recordStep(name, input, fn) : fn());

  const historyContext =
    history.length > 1
      ? "Recent conversation:\n" +
        history
          .slice(-8)
          .map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.content}`)
          .join("\n") +
        "\n\n"
      : "";

  const uiUsage = [
    "## UI tools — show_form and show_view",
    "Two tools drive the chat UI: `show_form` for input, `show_view` for output.",
    "",
    "**Use `show_form` whenever you need structured input.** Examples: which channel " +
      "to publish on, which persona to target, picking a campaign from a list, " +
      "naming a new campaign, choosing a tone. NEVER list field names in plain text " +
      "and ask the user to reply in freeform — call show_form with a fields array. " +
      "Field types: text / email / number / select (with options) / textarea. The " +
      "tool result is { [name]: value }; use those values directly.",
    "",
    "**Use `show_view` to present structured output.** After `run_strategist` returns " +
      "a calendar, emit a show_view with a `plan` block instead of pasting the JSON " +
      "or a markdown table. After `run_analyst` returns metrics, use a `table` or " +
      "`key_value` block. After `dispatch_workflow` returns a workflowRunId, use a " +
      "short `text` (intent: 'success') + `key_value` showing the id and the " +
      "tracking link. NEVER reproduce structured data as plain markdown when a " +
      "view block fits — the UI renders the spec as a real card.",
    "",
    "After a `show_form` result arrives or a `show_view` renders, follow up with " +
      "a brief plain-text sentence telling the user what you did and what's next.",
    "",
    "**End most turns with `suggest_followups`** — 2–3 short, specific phrases " +
      "the user is likely to ask next (max 60 chars each). The UI renders them " +
      "as clickable chips below your message. Call it ONCE, at the very end of " +
      "your reply. Skip when the conversation has clearly concluded (the user " +
      "said thanks, a workflow dispatched, or you gave a definitive final answer).",
  ].join("\n");

  const orchestratorBody = await getPrompt(
    "orchestrator.system",
    ORCHESTRATOR_PROMPT,
  );
  const systemPrompt = [
    orchestratorBody,
    "---",
    uiUsage,
    ...(systemContext ? ["---", systemContext] : []),
  ].join("\n\n");

  // Knowledge-base tools (read-only subset) — give the chat direct semantic
  // access to brand/persona/competitor/SOP/playbook docs without needing to
  // spin up the researcher sub-agent.
  const kbTools = buildKbTools({ workspaceId, actorId: userId });
  const { kb_search, kb_read_document, kb_list } = kbTools;

  // Workspace-scoped read tools. These replace the older Control-Plane HTTP
  // tools that were hardcoded to the Legacy workspace, so the chat now
  // reflects whichever workspace the caller is signed into.
  const workspaceTools = buildWorkspaceTools({ workspaceId });

  // Chat-attachment lifecycle tools. `attachment_read` resolves a temporary
  // upload by id; `kb_archive_attachment` promotes a valuable one into the KB.
  const attachmentTools = buildAttachmentTools({ workspaceId, userId });

  // UI driver tools. `show_form` is human-in-the-loop (no execute — the
  // client renders the form and feeds values back via addToolResult).
  // `show_view` renders read-only structured panels for plans, tables, status.
  const uiTools = buildUiTools();

  return {
    resolvedModel,
    // System prompt is returned separately so callers can prepend it as a
    // CoreSystemMessage with Anthropic `cacheControl: ephemeral`. Passing it
    // as the top-level `system: string` does not currently expose a way to
    // attach provider options, so it would skip prompt caching entirely.
    systemPrompt,
    // The text-style `prompt` for legacy callers that pass a single message
    // plus a history block. New `messages`-style callers ignore this and pass
    // `messages: convertToCoreMessages(uiMessages)` to streamText instead,
    // spreading `baseArgs` alongside.
    prompt: `${historyContext}User (${userId}): ${text}`,
    baseArgs: {
      model: getLanguageModel(resolvedModel),
      maxSteps: 10,
      tools: {
      // ── Flow: Workspace state (campaigns / posts / approvals / runs) ───
      ...workspaceTools,

      // ── Flow: Chat attachments (temporary uploads + KB promotion) ─────
      ...attachmentTools,

      check_publish_job: tool({
        description:
          "Check the current status of a publish job by id. Falls back to list_publish_jobs for content lookups.",
        parameters: z.object({
          publishJobId: z.string().describe("Specific publish job UUID"),
        }),
        execute: async ({ publishJobId }) => {
          return cp.getPublishJob(publishJobId);
        },
      }),

      // ── Flow: Knowledge Base (semantic memory across past chats + docs) ─
      kb_search,
      kb_read_document,
      kb_list,

      remember_insight: tool({
        description:
          "Save a durable user-stated preference, brand voice rule, recurring need, or fact " +
          "as a playbook document in the Knowledge Base so future chats and sub-agents can use it. " +
          "Only call this when the user has clearly stated something worth remembering across sessions " +
          "(e.g. 'always cite a customer quote', 'our ICP is mid-market FinTech CISOs'). " +
          "Do NOT call this for one-off task details or transient context. " +
          "Set scope='team' for org-wide rules (brand voice, ICP, process); " +
          "scope='personal' when it only applies to this user's own workflow.",
        parameters: z.object({
          title: z.string().describe("Short human-readable title for the insight"),
          slug: z
            .string()
            .regex(/^[a-z0-9-]+$/)
            .describe(
              "kebab-case slug. For personal scope, the system namespaces it per user — do NOT include the user id.",
            ),
          body_md: z
            .string()
            .describe(
              "Markdown body. Lead with the rule/fact, then a short Why and How-to-apply.",
            ),
          scope: z.enum(["team", "personal"]).optional().default("team"),
          tags: z.array(z.string()).optional(),
        }),
        execute: async ({ title, slug, body_md, scope, tags }) => {
          return persistChatInsight({
            title,
            slug,
            body_md,
            tags,
            scope: scope ?? "team",
            userId,
            workspaceId,
          });
        },
      }),

      // ── Flow: Research (web + KB ingestion) ────────────────────────────
      run_researcher: tool({
        description:
          "Run the Researcher sub-agent for audience, persona, competitor, market, or daily-news research. " +
          "Searches the public web with the configured provider (Tavily or Brave), fetches primary sources, " +
          "and writes findings into the Knowledge Base. Prefer kb_search for facts we may already have. " +
          "Pass a focused question — one topic per run.",
        parameters: z.object({
          request: z
            .string()
            .describe(
              "Natural-language research instruction. For daily news, phrase it like 'Daily news scan for <keyword>'.",
            ),
          campaignId: z
            .string()
            .optional()
            .describe(
              "When set, KB findings are scoped to this campaign instead of the global collection.",
            ),
        }),
        execute: async ({ request, campaignId }) => {
          return recordStep("researcher", { request, campaignId }, () =>
            withSpan(
              "sub-agent.researcher",
              { campaignId: campaignId ?? "" },
              () => {
                log.info({ campaignId }, "invoking researcher sub-agent");
                return runResearcher({
                  request,
                  workspaceId,
                  campaignId,
                  cp,
                  model: modelFor("researcher"),
                  threadRef,
                  jobId: tracker?.getJobId() ?? null,
                  searchProvider: researchProvider,
                });
              },
            ),
          );
        },
      }),

      // ── Flow: Planning ─────────────────────────────────────────────────
      run_strategist: tool({
        description:
          "INLINE strategy Q&A on an EXISTING campaign only. campaignId is " +
          "REQUIRED — the tool cannot be called without one. " +
          "Use this for short refinements like 'tweak the brief of campaign X', " +
          "'add 2 more LinkedIn posts to campaign Z's calendar', or 'what " +
          "stage should post W be in?'. " +
          "To create a NEW campaign (brief + calendar + visual identity), call " +
          "dispatch_workflow({ kind: 'campaign', request }) — it returns in " +
          "seconds with a workflow_runs id and runs the planner in the " +
          "background. The strategist takes 1–3 minutes; inlining it for a " +
          "new campaign would freeze the chat. There is no 'inline new " +
          "campaign' path on purpose.",
        parameters: z.object({
          request: z.string().describe("Natural-language instruction for the strategist"),
          campaignId: z
            .string()
            .describe(
              "REQUIRED. The existing campaign this refinement applies to. " +
              "If there is no existing campaign, do NOT call this tool — call " +
              "dispatch_workflow({ kind: 'campaign' }) instead.",
            ),
        }),
        // The second arg carries the toolCallId of THIS run_strategist call in
        // the parent stream. We forward each internal step (read_memory,
        // find_brand_guidance, …) onto the SSE bus tagged with that id so the
        // chat client can render them nested under the parent chip live.
        execute: async ({ request, campaignId }, { toolCallId }) => {
          return recordStep("strategist", { request, campaignId }, () =>
            withSpan("sub-agent.strategist", { campaignId }, () => {
              log.info({ campaignId }, "invoking strategist");
              return runStrategist({
                request,
                workspaceId,
                campaignId,
                cp,
                model: modelFor("strategist"),
                threadRef,
                jobId: tracker?.getJobId() ?? null,
                onSubStep: (ev) => {
                  publishWebThreadEvent(String(threadRef), {
                    kind: "sub_step",
                    step: {
                      parentToolCallId: toolCallId,
                      parentTool: "run_strategist",
                      step: ev.tool,
                      state: ev.state,
                      args: ev.args,
                      result: ev.state === "result" ? ev.result : undefined,
                      at: Date.now(),
                    },
                  });
                },
              });
            }),
          );
        },
      }),

      // ── Flow: Content ──────────────────────────────────────────────────
      run_content: tool({
        description: "Run the Content sub-agent to draft or revise a piece of content",
        parameters: z.object({
          request: z.string().describe("What to draft or revise"),
          campaignId: z.string().describe("Campaign the content belongs to"),
          contentId: z.string().optional().describe("Existing content item ID if revising"),
        }),
        execute: async ({ request, campaignId, contentId }) => {
          return recordStep(
            "content",
            { request, campaignId, contentId },
            () =>
              withSpan(
                "sub-agent.content",
                { campaignId, contentId: contentId ?? "" },
                async () => {
                  log.info({ campaignId, contentId }, "invoking content sub-agent");
                  if (tracker) {
                    await tracker.link({
                      campaignId,
                      ...(contentId ? { contentId } : {}),
                    });
                  }
                  return runContent({
                    request,
                    workspaceId,
                    campaignId,
                    contentId,
                    cp,
                    threadRef,
                    model: modelFor("content"),
                    jobId: tracker?.getJobId() ?? null,
                    postToThread: async (payload) => {
                      await cp.notifyThread({
                        threadRef: threadRef as never,
                        ...(typeof payload === "string"
                          ? { message: payload }
                          : { card: payload }),
                      });
                    },
                  });
                },
              ),
          );
        },
      }),

      // ── Flow: Visual ───────────────────────────────────────────────────
      run_asset: tool({
        description: "Run the Asset sub-agent to generate a visual asset for content",
        parameters: z.object({
          request: z.string(),
          contentId: z.string().optional(),
        }),
        execute: async ({ request, contentId }) => {
          return recordStep("asset", { request, contentId }, () =>
            withSpan("sub-agent.asset", { contentId: contentId ?? "" }, async () => {
              log.info({ contentId }, "invoking asset sub-agent");
              if (tracker && contentId) await tracker.link({ contentId });
              return runAsset({
                request,
                workspaceId,
                contentId,
                cp,
                model: modelFor("asset"),
                threadRef,
                jobId: tracker?.getJobId() ?? null,
              });
            }),
          );
        },
      }),

      // ── Flow: Analysis & Learning ──────────────────────────────────────
      run_analyst: tool({
        description: "Run the Analyst sub-agent for performance reports and learnings",
        parameters: z.object({
          request: z.string(),
          campaignId: z.string().optional(),
        }),
        execute: async ({ request, campaignId }) => {
          return recordStep("analyst", { request, campaignId }, () =>
            withSpan("sub-agent.analyst", { campaignId: campaignId ?? "" }, () => {
              log.info({ campaignId }, "invoking analyst sub-agent");
              return runAnalyst({
                request,
                workspaceId,
                campaignId,
                cp,
                model: modelFor("analyst"),
                threadRef,
                jobId: tracker?.getJobId() ?? null,
              });
            }),
          );
        },
      }),

      // ── Flow: Distribution ─────────────────────────────────────────────
      run_distributor: tool({
        description: "Schedule an approved content item for publishing on a channel",
        parameters: z.object({
          contentId: z.string().describe("ID of an approved content item"),
          channel: z.enum(["internal_blog", "linkedin", "x", "email_hubspot", "email_mailchimp"]),
          scheduledAt: z.string().optional().describe("ISO datetime; omit for immediate"),
        }),
        execute: async ({ contentId, channel, scheduledAt }) => {
          return recordStep(
            "distributor",
            { contentId, channel, scheduledAt },
            () =>
              withSpan(
                "tool.run_distributor",
                { contentId, channel },
                async () => {
                  log.info({ contentId, channel }, "invoking distributor via cp-client");
                  if (tracker) await tracker.link({ contentId });
                  const job = await cp.enqueuePublish({
                    contentId,
                    channel,
                    scheduledAt,
                    threadRef,
                  });
                  return { publishJobId: job.id, status: job.status };
                },
              ),
          );
        },
      }),

      // ── Flow: Dispatch (real workflow-engine run) ──────────────────────
      // This is the ONLY tool that creates a workflow_runs row visible on
      // the Workflow Observability dashboard. Sub-agent tools above do
      // in-process drafting only.
      dispatch_workflow: tool({
        description:
          "Kick off a real workflow-engine run (kind = campaign | single_post | asset). " +
          "Use ONLY when the user wants the full pipeline to produce reviewable artifacts " +
          "(campaign brief + calendar + drafts in DB, or a single post drafted + submitted " +
          "for approval, or an asset generated for a specific content item). The dispatcher " +
          "creates a workflow_runs row and returns its id. The run executes asynchronously — " +
          "the chat will detach with a tracking link and post the final result back to this " +
          "thread when it's ready.\n\n" +
          "Use run_strategist / run_content / run_asset instead for quick inline drafts that " +
          "the user just wants to see in chat without DB artifacts or an approval flow.",
        parameters: z.object({
          kind: z.enum(["campaign", "single_post", "asset"]),
          request: z
            .string()
            .min(1)
            .max(8000)
            .describe("Natural-language brief describing what to generate."),
          campaignId: z
            .string()
            .uuid()
            .optional()
            .describe(
              "Existing campaign to attach to. Required for single_post on non-vercel engines.",
            ),
          contentId: z
            .string()
            .uuid()
            .optional()
            .describe("Existing content item; used by kind='asset'."),
          channel: z
            .enum(CHANNELS)
            .optional()
            .describe("Target channel for kind='single_post'."),
          media: z
            .enum(WORKFLOW_MEDIA)
            .optional()
            .describe(
              "Hard override for visual format: 'image' = image only, 'video' = video only (forced even on channels that don't normally get video), 'both' = image AND video, 'auto' = channel default. Set this whenever the user names a format ('make a video', 'video for LinkedIn', 'just an image'). Leave undefined to let the channel decide.",
            ),
        }),
        execute: async ({ kind, request, campaignId, contentId, channel, media }) => {
          try {
            const engineId = await getDefaultWorkflowEngine();
            const dispatchModel = model ?? (await getDefaultWorkflowModel());
            const result = await dispatchStart(engineId, {
              kind,
              workspaceId,
              request,
              campaignId,
              contentId,
              channel,
              media,
              threadRef,
              model: dispatchModel,
              userId,
            });
            if (tracker) {
              tracker.notifyWorkflowDispatched(result.workflowRunId);
              if (campaignId || contentId) {
                await tracker.link({
                  ...(campaignId ? { campaignId } : {}),
                  ...(contentId ? { contentId } : {}),
                });
              }
            }
            log.info(
              {
                kind,
                workflowRunId: result.workflowRunId,
                engine: result.engine,
              },
              "dispatch_workflow succeeded",
            );
            return {
              workflowRunId: result.workflowRunId,
              engine: result.engine,
              engineRunRef: result.engineRunRef,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error({ err: message, kind }, "dispatch_workflow failed");
            // Return the error to the LLM so it can apologise to the user
            // instead of throwing and aborting the whole turn.
            return { error: message };
          }
        },
      }),

      // ── Flow: UI (forms + read-only views) ─────────────────────────────
      // `show_form` replaces the old text-only `clarify` tool — instead of
      // typing a question, the model emits a form the user fills in and the
      // structured values come back as the tool result.
      // `show_view` is how structured sub-agent output (plan calendars,
      // tables, key/value summaries, status callouts) reaches the UI.
      ...uiTools,
    },
    } as const,
  };
}

async function _runOrchestrator(input: OrchestratorInput): Promise<string> {
  const [{ resolvedModel, baseArgs, systemPrompt, prompt }, knowledgeBlock] =
    await Promise.all([
      buildOrchestratorCall(input),
      buildKnowledgeContext({ workspaceId: input.workspaceId, query: input.text }),
    ]);
  const {
    text: response,
    steps,
    usage,
    experimental_providerMetadata,
  } = await generateText({
    ...baseArgs,
    messages: [
      cachedSystemMessage(systemPrompt),
      ...uncachedSystem(knowledgeBlock),
      { role: "user", content: prompt },
    ],
  });
  log.info({ steps: steps.length }, "orchestrator finished");
  await recordLlmUsage({
    agent: "orchestrator",
    workspaceId: input.workspaceId,
    model: resolvedModel,
    threadRef: input.threadRef,
    jobId: input.tracker?.getJobId() ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });
  return response;
}

export type StreamOrchestratorOpts = {
  /** Fired for every text delta the orchestrator emits. */
  onDelta: (text: string) => void;
};

/**
 * Streaming counterpart of `runOrchestrator`. Mirrors the same tools, system
 * prompt, and history wiring — only the LLM call differs (`streamText`).
 *
 * We always drive the underlying stream to completion in the background and
 * fire deltas via `onDelta`. The returned promise resolves with the full
 * accumulated text once the orchestrator finishes — so callers that bail
 * early (e.g. on workflow detach) can still persist the final answer when
 * the orchestrator catches up.
 */
export function streamOrchestrator(
  input: OrchestratorInput,
  opts: StreamOrchestratorOpts,
): Promise<string> {
  return withSpan(
    "orchestrator.stream",
    { userId: input.userId, threadRef: input.threadRef },
    () => _streamOrchestrator(input, opts),
  );
}

async function _streamOrchestrator(
  input: OrchestratorInput,
  opts: StreamOrchestratorOpts,
): Promise<string> {
  const [{ resolvedModel, baseArgs, systemPrompt, prompt }, knowledgeBlock] =
    await Promise.all([
      buildOrchestratorCall(input),
      buildKnowledgeContext({ workspaceId: input.workspaceId, query: input.text }),
    ]);
  const result = streamText({
    ...baseArgs,
    messages: [
      cachedSystemMessage(systemPrompt),
      ...uncachedSystem(knowledgeBlock),
      { role: "user", content: prompt },
    ],
  });

  let accumulated = "";
  for await (const delta of result.textStream) {
    accumulated += delta;
    try {
      opts.onDelta(delta);
    } catch (err) {
      // A throwing consumer must not prevent the orchestrator from finishing —
      // log and keep draining. Callers signal "stop forwarding" by ignoring
      // further calls, not by throwing.
      log.warn({ err: (err as Error).message }, "stream onDelta callback threw");
    }
  }

  const usage = await result.usage;
  const providerMetadata = await result.experimental_providerMetadata;
  const steps = await result.steps;
  log.info({ steps: steps.length }, "orchestrator stream finished");
  await recordLlmUsage({
    agent: "orchestrator",
    workspaceId: input.workspaceId,
    model: resolvedModel,
    threadRef: input.threadRef,
    jobId: input.tracker?.getJobId() ?? null,
    usage,
    providerMetadata,
  });
  return accumulated;
}

// ─────────────────────────────────────────────────────────────────────────
// UI-message variant (data stream protocol for the AI SDK's useChat)
// ─────────────────────────────────────────────────────────────────────────

export type StreamOrchestratorUiInput = Omit<OrchestratorInput, "history" | "text"> & {
  /**
   * Full UIMessage[] from the client. The last entry must be a user message —
   * useChat sends the entire conversation on each turn.
   */
  messages: Message[];
};

export type StreamOrchestratorUiOpts = {
  /**
   * Called once the LLM finishes (including all auto-executed tool steps).
   * Receives the merged UIMessage[] (request + assistant response messages)
   * so callers can persist the full transcript. Failures are swallowed —
   * persistence must not break the stream response.
   */
  onFinishMessages?: (merged: Message[]) => Promise<void> | void;
};

/**
 * UseChat-compatible orchestrator stream. Returns a Response carrying the
 * AI SDK data stream protocol; the client consumes it with
 * `useChat({ api })` and renders `message.parts` directly.
 *
 * Detach semantics: when the orchestrator calls `dispatch_workflow`, the tool
 * result lands in the message as a tool-invocation part; the client renders
 * a "workflow started" card from that part and the assistant's follow-up
 * text streams in normally. We no longer close the stream early — the user
 * gets richer mid-stream feedback than the old "kill it" approach gave.
 */
export function streamOrchestratorUi(
  input: StreamOrchestratorUiInput,
  opts: StreamOrchestratorUiOpts = {},
): Promise<Response> {
  return withSpan(
    "orchestrator.stream.ui",
    { userId: input.userId, threadRef: input.threadRef },
    () => _streamOrchestratorUi(input, opts),
  );
}

async function _streamOrchestratorUi(
  input: StreamOrchestratorUiInput,
  opts: StreamOrchestratorUiOpts,
): Promise<Response> {
  const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
  const userText =
    lastUser?.content ??
    lastUser?.parts?.find((p) => p.type === "text")?.text ??
    "";

  const [{ resolvedModel, baseArgs, systemPrompt }, knowledgeBlock] =
    await Promise.all([
      buildOrchestratorCall({
        ...input,
        text: userText,
        // History block is duplicative — `messages` already carries every turn.
        history: [],
      }),
      buildKnowledgeContext({ workspaceId: input.workspaceId, query: userText }),
    ]);

  const result = streamText({
    ...baseArgs,
    messages: [
      cachedSystemMessage(systemPrompt),
      ...uncachedSystem(knowledgeBlock),
      ...convertToCoreMessages(input.messages),
    ],
    onFinish: async ({ response, usage, providerMetadata }) => {
      try {
        await recordLlmUsage({
          agent: "orchestrator",
          workspaceId: input.workspaceId,
          model: resolvedModel,
          threadRef: input.threadRef,
          jobId: input.tracker?.getJobId() ?? null,
          usage,
          providerMetadata,
        });
      } catch (err) {
        log.warn({ err: (err as Error).message }, "recordLlmUsage failed (ui stream)");
      }

      if (opts.onFinishMessages) {
        try {
          const merged = appendResponseMessages({
            messages: input.messages,
            responseMessages: response.messages,
          });
          await opts.onFinishMessages(merged);
        } catch (err) {
          log.warn({ err: (err as Error).message }, "onFinishMessages threw (ui stream)");
        }
      }
    },
  });

  return result.toDataStreamResponse({
    sendUsage: true,
    sendReasoning: true,
    // Without this, any mid-stream error becomes the generic "An error
    // occurred" in the client. We log the full error server-side too — the
    // client banner gets the message string for fast triage.
    getErrorMessage: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, "ui stream error");
      return message;
    },
  });
}

// Wraps the orchestrator system prompt as a CoreSystemMessage with Anthropic
// ephemeral cache control. Non-Anthropic providers ignore providerOptions, so
// this is safe to apply unconditionally. The system block is by far the
// largest stable input on every turn — caching it cuts steady-state input
// cost by ~90% on Claude.
function cachedSystemMessage(systemPrompt: string): CoreMessage {
  return {
    role: "system",
    content: systemPrompt,
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };
}

// Wrap a per-turn block (today: kb_search hits) as a non-cached system
// message AFTER the cached orchestrator prompt. The Anthropic provider packs
// consecutive system messages into a single multi-block `system` field; the
// cache breakpoint stays on the first block, so this block doesn't bust the
// cache but also doesn't get cached (which is correct — its content changes
// every turn). Returns an empty array when the block is empty so we don't
// inject a useless system message.
function uncachedSystem(block: string): CoreMessage[] {
  if (!block.trim()) return [];
  return [{ role: "system", content: block }];
}

async function loadResearchProvider() {
  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "research_search_provider"))
      .limit(1);
    return resolveResearchSearchProvider(row?.value);
  } catch {
    return resolveResearchSearchProvider(undefined);
  }
}

const CHAT_INSIGHTS_COLLECTION = {
  slug: "chat-insights",
  name: "Chat Insights",
  kind: "playbook" as const,
};

async function persistChatInsight(opts: {
  title: string;
  slug: string;
  body_md: string;
  tags?: string[];
  scope: "team" | "personal";
  userId: string;
  workspaceId: string;
}): Promise<{ documentId: string; status: string; warning?: string }> {
  if (!process.env.OPENAI_API_KEY) {
    log.warn(
      "OPENAI_API_KEY not set — insight would not be searchable. Skipping write.",
    );
    return {
      documentId: "",
      status: "skipped",
      warning:
        "OPENAI_API_KEY not set: insights cannot be embedded for retrieval. Set the key in env to enable remember_insight.",
    };
  }
  const collectionId = await ensureCollection({
    workspaceId: opts.workspaceId,
    slug: CHAT_INSIGHTS_COLLECTION.slug,
    name: CHAT_INSIGHTS_COLLECTION.name,
    kind: CHAT_INSIGHTS_COLLECTION.kind,
    scope: "global",
    campaignId: null,
  });
  const persistedSlug =
    opts.scope === "personal" ? `${opts.slug}-u-${shortUserHash(opts.userId)}` : opts.slug;
  const doc = await upsertDocument({
    workspaceId: opts.workspaceId,
    collectionId,
    slug: persistedSlug,
    title: opts.title,
    source: "agent",
    bodyMd: opts.body_md,
    metadata: {
      capturedBy: opts.userId,
      userId: opts.userId,
      tags: opts.tags ?? [],
      scope: opts.scope,
      origin: "chat",
    },
    status: "active",
    createdBy: opts.userId,
    bumpVersion: true,
  });
  await chunkAndEmbed(doc.id).catch((err) =>
    log.warn({ err: (err as Error).message, docId: doc.id }, "chat insight embed failed"),
  );
  return { documentId: doc.id, status: doc.status };
}

function shortUserHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).slice(0, 6);
}
