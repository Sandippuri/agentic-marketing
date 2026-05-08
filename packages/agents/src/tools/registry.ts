/**
 * Single source of truth for the tools the orchestrator and the goal-loop
 * workflow expose to the LLM. Centralising avoids drift between the chat
 * orchestrator and the durable workflow when both invoke the same sub-agent.
 *
 * Builders here return plain `tool()` objects keyed by tool name; callers
 * (orchestrator, goal-loop steps) spread them into their own `tools: { ... }`.
 *
 * Tools are grouped:
 *   - sub-agent runners (run_strategist, run_content, run_asset, run_analyst)
 *   - cp queries     (list_campaigns, get_pending_approvals, check_publish_job)
 *   - kb tools       (kb_search, kb_read_document, kb_list, …) [from kb-tools.ts]
 *   - control tools  (clarify, schedule_publish, submit_for_review,
 *                     read_approval_decision, query_outcomes, propose_winner)
 *
 * NOTE: this file does NOT define the new sub-agent runners (researcher, seo,
 * experiment, lifecycle) — those land in Phase 3 and add to the registry then.
 */
import { tool } from "ai";
import { z } from "zod";
import type { CpClient } from "@marketing/cp-client";
import type { LlmModel, ThreadRef } from "@marketing/shared-types";
import { runStrategist } from "../sub-agents/strategist";
import { runContent } from "../sub-agents/content";
import { runAsset } from "../sub-agents/asset";
import { runAnalyst } from "../sub-agents/analyst";
import { runResearcher } from "../sub-agents/researcher";
import { runSeo } from "../sub-agents/seo";
import { runExperiment } from "../sub-agents/experiment";
import { runLifecycle } from "../sub-agents/lifecycle";
import { buildKbTools, type KbToolContext } from "./kb-tools";

export type ToolRegistryContext = {
  cp: CpClient;
  threadRef?: ThreadRef | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  /** Per-sub-agent model override resolver. */
  modelFor: (
    kind: "strategist" | "content" | "asset" | "analyst",
  ) => LlmModel | undefined;
  /** Optional progress tracker; sub-agents that should record steps. */
  recordStep?: <T>(
    name: "strategist" | "content" | "asset" | "analyst" | "distributor",
    input: Record<string, unknown>,
    fn: () => Promise<T>,
  ) => Promise<T>;
  kb?: KbToolContext;
  /** When set, run_content posts the approval card here. */
  postToThread?: (payload: string | object) => Promise<void> | void;
};

export function buildSubAgentTools(ctx: ToolRegistryContext) {
  const step = ctx.recordStep ?? (async (_n, _i, fn) => fn());
  return {
    run_strategist: tool({
      description:
        "Run the Strategist sub-agent for campaign planning, briefs, and calendars. Always reads the Knowledge Base for brand voice, ICP, and past wins before producing the plan.",
      parameters: z.object({
        request: z.string(),
        campaignId: z.string().optional(),
      }),
      execute: async ({ request, campaignId }) =>
        step("strategist", { request, campaignId }, () =>
          runStrategist({
            request,
            campaignId,
            cp: ctx.cp,
            model: ctx.modelFor("strategist"),
            threadRef: ctx.threadRef ?? undefined,
            jobId: ctx.jobId ?? null,
            workflowRunId: ctx.workflowRunId ?? null,
          }),
        ),
    }),

    run_content: tool({
      description:
        "Run the Content sub-agent to draft or revise a piece of content. Reads the KB, the brand SOP for the target channel, similar past wins, and any reviewer 'changes_requested' reason.",
      parameters: z.object({
        request: z.string(),
        campaignId: z.string(),
        contentId: z.string().optional(),
      }),
      execute: async ({ request, campaignId, contentId }) =>
        step("content", { request, campaignId, contentId }, () =>
          runContent({
            request,
            campaignId,
            contentId,
            cp: ctx.cp,
            threadRef: ctx.threadRef ?? undefined,
            model: ctx.modelFor("content"),
            jobId: ctx.jobId ?? null,
            workflowRunId: ctx.workflowRunId ?? null,
            postToThread: ctx.postToThread
              ? async (payload) => {
                  await ctx.postToThread!(payload);
                }
              : undefined,
          }),
        ),
    }),

    run_asset: tool({
      description:
        "Run the Asset sub-agent to generate a visual asset for content. As of Phase 2.5 this routes through the Art Director pipeline (concept brief, KB visual references, multi-candidate generation, vision-LLM judge).",
      parameters: z.object({
        request: z.string(),
        contentId: z.string().optional(),
      }),
      execute: async ({ request, contentId }) =>
        step("asset", { request, contentId }, () =>
          runAsset({
            request,
            contentId,
            cp: ctx.cp,
            model: ctx.modelFor("asset"),
            threadRef: ctx.threadRef ?? undefined,
            jobId: ctx.jobId ?? null,
            workflowRunId: ctx.workflowRunId ?? null,
          }),
        ),
    }),

    run_analyst: tool({
      description:
        "Run the Analyst sub-agent for performance reports and learnings. Reads outcomes + GA4.",
      parameters: z.object({
        request: z.string(),
        campaignId: z.string().optional(),
      }),
      execute: async ({ request, campaignId }) =>
        step("analyst", { request, campaignId }, () =>
          runAnalyst({
            request,
            campaignId,
            cp: ctx.cp,
            model: ctx.modelFor("analyst"),
            threadRef: ctx.threadRef ?? undefined,
            jobId: ctx.jobId ?? null,
            workflowRunId: ctx.workflowRunId ?? null,
          }),
        ),
    }),

    run_researcher: tool({
      description:
        "Run the Researcher sub-agent for audience / persona / competitor / market research. Reads the KB first, fetches external pages, writes findings back to the KB.",
      parameters: z.object({
        request: z.string(),
        campaignId: z.string().optional(),
      }),
      execute: async ({ request, campaignId }) =>
        runResearcher({
          request,
          campaignId,
          cp: ctx.cp,
          model: ctx.modelFor("analyst"),
          threadRef: ctx.threadRef ?? undefined,
          jobId: ctx.jobId ?? null,
          workflowRunId: ctx.workflowRunId ?? null,
        }),
    }),

    run_seo: tool({
      description:
        "Run the SEO sub-agent: keyword research, on-page metadata, h-tag outline. Writes seo_meta back to content_items.",
      parameters: z.object({
        request: z.string(),
        contentId: z.string().optional(),
        campaignId: z.string().optional(),
      }),
      execute: async ({ request, contentId, campaignId }) =>
        runSeo({
          request,
          contentId,
          campaignId,
          cp: ctx.cp,
          model: ctx.modelFor("content"),
          threadRef: ctx.threadRef ?? undefined,
          jobId: ctx.jobId ?? null,
          workflowRunId: ctx.workflowRunId ?? null,
        }),
    }),

    run_experiment: tool({
      description:
        "Run the Growth/Experiment sub-agent: register an A/B experiment, propose a winner once threshold met. Variant content drafting is delegated back to run_content with the shared variantGroup.",
      parameters: z.object({
        request: z.string(),
        campaignId: z.string(),
      }),
      execute: async ({ request, campaignId }) =>
        runExperiment({
          request,
          campaignId,
          cp: ctx.cp,
          model: ctx.modelFor("strategist"),
          threadRef: ctx.threadRef ?? undefined,
          jobId: ctx.jobId ?? null,
          workflowRunId: ctx.workflowRunId ?? null,
        }),
    }),

    run_lifecycle: tool({
      description:
        "Run the Lifecycle/CRM sub-agent: design multi-step email sequences with delays, triggers, and per-step content briefs.",
      parameters: z.object({
        request: z.string(),
        campaignId: z.string(),
      }),
      execute: async ({ request, campaignId }) =>
        runLifecycle({
          request,
          campaignId,
          cp: ctx.cp,
          model: ctx.modelFor("strategist"),
          threadRef: ctx.threadRef ?? undefined,
          jobId: ctx.jobId ?? null,
          workflowRunId: ctx.workflowRunId ?? null,
        }),
    }),
  };
}

export function buildCpQueryTools(ctx: ToolRegistryContext) {
  return {
    list_campaigns: tool({
      description:
        "List campaigns from the Control Plane. Use this to find a campaign id before routing to other tools.",
      parameters: z.object({}),
      execute: async () => {
        const campaigns = await ctx.cp.listCampaigns();
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
        "List content items currently waiting for human approval, oldest first.",
      parameters: z.object({
        limit: z.number().int().min(1).max(20).optional().default(10),
      }),
      execute: async ({ limit }) => ctx.cp.getPendingApprovals(limit),
    }),

    check_publish_job: tool({
      description:
        "Check the status of a publish job by id, or list recent jobs for a content item.",
      parameters: z.object({
        publishJobId: z.string().optional(),
        contentId: z.string().optional(),
      }),
      execute: async ({ publishJobId, contentId }) => {
        if (publishJobId) return ctx.cp.getPublishJob(publishJobId);
        if (contentId) return ctx.cp.listPublishJobs({ contentId, limit: 5 });
        return { error: "provide publishJobId or contentId" };
      },
    }),

    schedule_publish: tool({
      description:
        "Schedule an approved content item for publishing on a channel. The job's mode (live|test) is inherited from the campaign / explicit override.",
      parameters: z.object({
        contentId: z.string(),
        channel: z.enum([
          "internal_blog",
          "linkedin",
          "x",
          "email_hubspot",
          "email_mailchimp",
        ]),
        scheduledAt: z.string().optional(),
      }),
      execute: async ({ contentId, channel, scheduledAt }) =>
        step("distributor", { contentId, channel, scheduledAt }, async () => {
          const job = await ctx.cp.enqueuePublish({
            contentId,
            channel,
            scheduledAt,
            threadRef: ctx.threadRef ?? undefined,
          });
          return { publishJobId: job.id, status: job.status };
        }),
    }),

    clarify: tool({
      description:
        "Ask the user a single clarifying question when intent is ambiguous. Pause execution.",
      parameters: z.object({ question: z.string() }),
      execute: async ({ question }) => question,
    }),
  };

  function step<T>(
    name: "strategist" | "content" | "asset" | "analyst" | "distributor",
    input: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return ctx.recordStep ? ctx.recordStep(name, input, fn) : fn();
  }
}

/** Build every tool the orchestrator needs (sub-agents + cp queries + kb). */
export function buildAllTools(ctx: ToolRegistryContext) {
  return {
    ...buildSubAgentTools(ctx),
    ...buildCpQueryTools(ctx),
    ...buildKbTools(ctx.kb ?? {}),
  };
}
