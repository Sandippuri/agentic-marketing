import { generateText, tool } from "ai";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { resolveLlmModel, type LlmModel, type ThreadRef } from "@marketing/shared-types";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import { ORCHESTRATOR_PROMPT } from "@marketing/prompts";
import { runStrategist } from "@marketing/agents/sub-agents/strategist";
import { runContent } from "@marketing/agents/sub-agents/content";
import { runAnalyst } from "@marketing/agents/sub-agents/analyst";
import { runAsset } from "@marketing/agents/sub-agents/asset";
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
  threadRef: ThreadRef;
  history: Array<{ role: string; content: string }>;
  cp: CpClient;
  model?: LlmModel;
  /**
   * Optional progress tracker. When provided, each sub-agent invocation is
   * recorded as a step in the generation_jobs table so the
   * /creation-workflow admin page can show step-by-step progress. The
   * orchestrator never reads back from the tracker — it's pure write-only
   * observability.
   */
  tracker?: GenerationTracker;
  /**
   * Optional extra system text appended after ORCHESTRATOR_PROMPT. Used to
   * scope a chat to a specific campaign (campaign brief + content items
   * snapshot) so tool calls default to that campaign without the user
   * restating it every turn.
   */
  systemContext?: string;
};

export function runOrchestrator(input: OrchestratorInput): Promise<string> {
  return withSpan("orchestrator", { userId: input.userId, threadRef: input.threadRef }, () =>
    _runOrchestrator(input),
  );
}

async function _runOrchestrator({
  text,
  userId,
  threadRef,
  history,
  cp,
  model,
  tracker,
  systemContext,
}: OrchestratorInput): Promise<string> {
  // Top-level orchestrator model: caller override wins, then the global
  // workflow_model setting, then DEFAULT_LLM_MODEL via resolveLlmModel.
  const { workflowModel, subAgentModels } = await getWorkflowModelConfig();
  const resolvedModel = model ? resolveLlmModel(model) : workflowModel;
  const modelFor = (kind: "strategist" | "content" | "asset" | "analyst") =>
    pickSubAgentModel({
      kind,
      // Only inherit the orchestrator's per-call override; don't double-apply
      // the workflow_model fallback (already baked into workflowModel).
      override: model,
      workflowModel,
      subAgentModels,
    });
  log.info(
    { userId, threadRef, msgLen: text.length, model: resolvedModel, subAgentModels },
    "orchestrator start",
  );

  type StepName = "strategist" | "content" | "asset" | "analyst" | "distributor";
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

  const { text: response, steps, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(resolvedModel),
    system: systemPrompt,
    prompt: `${historyContext}User (${userId}): ${text}`,
    maxSteps: 10,
    tools: {
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

      list_campaigns: tool({
        description:
          "List all campaigns from the Control Plane. Use this to find a campaign ID " +
          "before routing to run_strategist or run_content.",
        parameters: z.object({}),
        execute: async () => {
          const campaigns = await cp.listCampaigns();
          return campaigns.map((c) => ({
            id: c.id,
            slug: c.slug,
            name: c.name,
            phase: c.phase,
            status: c.status,
          }));
        },
      }),

      get_pending_approvals: tool({
        description:
          "List all content items currently waiting for human approval, oldest first.",
        parameters: z.object({
          limit: z.number().int().min(1).max(20).optional().default(10),
        }),
        execute: async ({ limit }) => {
          return cp.getPendingApprovals(limit);
        },
      }),

      check_publish_job: tool({
        description:
          "Check the current status of a publish job by ID, or list recent jobs for a content item.",
        parameters: z.object({
          publishJobId: z.string().optional().describe("Specific publish job UUID"),
          contentId: z.string().optional().describe("List all jobs for this content item"),
        }),
        execute: async ({ publishJobId, contentId }) => {
          if (publishJobId) return cp.getPublishJob(publishJobId);
          if (contentId) return cp.listPublishJobs({ contentId, limit: 5 });
          return { error: "provide publishJobId or contentId" };
        },
      }),

      clarify: tool({
        description: "Ask the user a single clarifying question when the intent is ambiguous",
        parameters: z.object({
          question: z.string(),
        }),
        execute: async ({ question }) => question,
      }),
    },
  });

  log.info({ steps: steps.length }, "orchestrator finished");
  await recordLlmUsage({
    agent: "orchestrator",
    model: resolvedModel,
    threadRef,
    jobId: tracker?.getJobId() ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });
  return response;
}
