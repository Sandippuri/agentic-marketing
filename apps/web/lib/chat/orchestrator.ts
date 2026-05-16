import { generateText, streamText, tool } from "ai";
import { z } from "zod";
import pino from "pino";
import { eq } from "drizzle-orm";
import type { CpClient } from "@marketing/cp-client";
import {
  resolveLlmModel,
  resolveResearchSearchProvider,
  type LlmModel,
  type ThreadRef,
} from "@marketing/shared-types";
import { getDb, schema } from "@marketing/db";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import { ORCHESTRATOR_PROMPT } from "@marketing/prompts";
import { runStrategist } from "@marketing/agents/sub-agents/strategist";
import { runContent } from "@marketing/agents/sub-agents/content";
import { runAnalyst } from "@marketing/agents/sub-agents/analyst";
import { runAsset } from "@marketing/agents/sub-agents/asset";
import { runResearcher } from "@marketing/agents/sub-agents/researcher";
import { buildKbTools } from "@marketing/agents/tools/kb-tools";
import { ensureCollection, upsertDocument } from "@marketing/agents/kb";
import { chunkAndEmbed } from "@marketing/agents/kb";
import { buildWorkspaceTools } from "./workspace-tools";
import {
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

  const systemPrompt = systemContext
    ? `${ORCHESTRATOR_PROMPT}\n\n---\n\n${systemContext}`
    : ORCHESTRATOR_PROMPT;

  // Knowledge-base tools (read-only subset) — give the chat direct semantic
  // access to brand/persona/competitor/SOP/playbook docs without needing to
  // spin up the researcher sub-agent.
  const kbTools = buildKbTools({ workspaceId, actorId: userId });
  const { kb_search, kb_read_document, kb_list } = kbTools;

  // Workspace-scoped read tools. These replace the older Control-Plane HTTP
  // tools that were hardcoded to the Legacy workspace, so the chat now
  // reflects whichever workspace the caller is signed into.
  const workspaceTools = buildWorkspaceTools({ workspaceId });

  return {
    resolvedModel,
    callArgs: {
      model: getLanguageModel(resolvedModel),
      system: systemPrompt,
      prompt: `${historyContext}User (${userId}): ${text}`,
      maxSteps: 10,
      tools: {
      // ── Flow: Workspace state (campaigns / posts / approvals / runs) ───
      ...workspaceTools,

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
        description: "Run the Strategist sub-agent for campaign planning, briefs, and calendars",
        parameters: z.object({
          request: z.string().describe("Natural-language instruction for the strategist"),
          campaignId: z.string().optional().describe("Existing campaign ID if refining a plan"),
        }),
        execute: async ({ request, campaignId }) => {
          return recordStep("strategist", { request, campaignId }, () =>
            withSpan("sub-agent.strategist", { campaignId: campaignId ?? "" }, () => {
              log.info({ campaignId }, "invoking strategist");
              return runStrategist({
                request,
                workspaceId,
                campaignId,
                cp,
                model: modelFor("strategist"),
                threadRef,
                jobId: tracker?.getJobId() ?? null,
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

      // ── Flow: Meta ─────────────────────────────────────────────────────
      clarify: tool({
        description: "Ask the user a single clarifying question when the intent is ambiguous",
        parameters: z.object({
          question: z.string(),
        }),
        execute: async ({ question }) => question,
      }),
    },
    } as const,
  };
}

async function _runOrchestrator(input: OrchestratorInput): Promise<string> {
  const { resolvedModel, callArgs } = await buildOrchestratorCall(input);
  const {
    text: response,
    steps,
    usage,
    experimental_providerMetadata,
  } = await generateText(callArgs);
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
  const { resolvedModel, callArgs } = await buildOrchestratorCall(input);
  const result = streamText(callArgs);

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
