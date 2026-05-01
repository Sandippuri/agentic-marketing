import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import type { ThreadRef } from "@marketing/shared-types";
import { ORCHESTRATOR_PROMPT } from "@marketing/prompts";
import { runStrategist } from "./sub-agents/strategist";
import { runContent } from "./sub-agents/content";
import { runAnalyst } from "./sub-agents/analyst";
import { runAsset } from "./sub-agents/asset";
import { withSpan } from "./telemetry";

const log = pino({ name: "orchestrator" });

export type OrchestratorInput = {
  text: string;
  userId: string;
  threadRef: ThreadRef;
  history: Array<{ role: string; content: string }>;
  cp: CpClient;
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
}: OrchestratorInput): Promise<string> {
  log.info({ userId, threadRef, msgLen: text.length }, "orchestrator start");

  // Build a brief conversation history string for context.
  const historyContext =
    history.length > 1
      ? "Recent conversation:\n" +
        history
          .slice(-8)
          .map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.content}`)
          .join("\n") +
        "\n\n"
      : "";

  const { text: response, steps } = await generateText({
    model: anthropic("claude-3-5-sonnet-20241022"),
    system: ORCHESTRATOR_PROMPT,
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
          return withSpan("sub-agent.strategist", { campaignId: campaignId ?? "" }, () => {
            log.info({ campaignId }, "invoking strategist");
            return runStrategist({ request, campaignId, cp });
          });
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
          return withSpan("sub-agent.content", { campaignId, contentId: contentId ?? "" }, () => {
            log.info({ campaignId, contentId }, "invoking content sub-agent");
            return runContent({
              request,
              campaignId,
              contentId,
              cp,
              threadRef,
              postToThread: async (payload) => {
                await cp.notifyThread({
                  threadRef: threadRef as never,
                  message: typeof payload === "string" ? payload : JSON.stringify(payload),
                });
              },
            });
          });
        },
      }),

      run_analyst: tool({
        description: "Run the Analyst sub-agent for performance reports and learnings",
        parameters: z.object({
          request: z.string(),
          campaignId: z.string().optional(),
        }),
        execute: async ({ request, campaignId }) => {
          return withSpan("sub-agent.analyst", { campaignId: campaignId ?? "" }, () => {
            log.info({ campaignId }, "invoking analyst sub-agent");
            return runAnalyst({ request, campaignId, cp });
          });
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
          return withSpan("tool.run_distributor", { contentId, channel }, async () => {
            log.info({ contentId, channel }, "invoking distributor via cp-client");
            const job = await cp.enqueuePublish({ contentId, channel, scheduledAt, threadRef });
            return { publishJobId: job.id, status: job.status };
          });
        },
      }),

      run_asset: tool({
        description: "Run the Asset sub-agent to generate a visual asset for content",
        parameters: z.object({
          request: z.string(),
          contentId: z.string().optional(),
        }),
        execute: async ({ request, contentId }) => {
          return withSpan("sub-agent.asset", { contentId: contentId ?? "" }, () => {
            log.info({ contentId }, "invoking asset sub-agent");
            return runAsset({ request, contentId, cp });
          });
        },
      }),

      list_campaigns: tool({
        description:
          "List all campaigns from the Control Plane. Use this to find a campaign ID " +
          "before routing to run_strategist or run_content. Avoids needing a sub-agent spin-up for simple lookups.",
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
          "List all content items currently waiting for human approval, oldest first. " +
          "Use when the user asks 'what needs review?' or 'what's in the queue?'.",
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
          if (publishJobId) {
            return cp.getPublishJob(publishJobId);
          }
          if (contentId) {
            return cp.listPublishJobs({ contentId, limit: 5 });
          }
          return { error: "provide publishJobId or contentId" };
        },
      }),

      clarify: tool({
        description: "Ask the user a single clarifying question when the intent is ambiguous",
        parameters: z.object({
          question: z.string(),
        }),
        execute: async ({ question }) => {
          // Return the question as the final reply — the orchestrator will surface it.
          return question;
        },
      }),
    },
  });

  log.info({ steps: steps.length }, "orchestrator finished");
  return response;
}
