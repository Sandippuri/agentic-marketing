// Vercel engine adapter — kicks off a Vercel Workflows run via the SDK.
// One branch per supported kind; each branch starts the matching workflow
// in apps/web/workflows. The capability list below drives the picker, so
// adding asset support = implement the workflow + add a branch.

import { start } from "workflow/api";
import {
  CHANNELS,
  type Channel,
  type LlmModel,
  type WorkflowMedia,
} from "@marketing/shared-types";
import { singlePostWorkflow } from "@/workflows/single-post";
import { campaignPlanWorkflow } from "@/workflows/campaign-plan";
import { executeCampaignWorkflow } from "@/workflows/execute-campaign";
import { assetWorkflow } from "@/workflows/asset";
import type { StartInput, WorkflowEngine } from "../types";

export const vercelEngine: WorkflowEngine = {
  id: "vercel",
  label: "Vercel",
  description: "Vercel Workflows runtime — durable, suspendable, hosted.",
  capability: {
    available: true,
    kinds: ["campaign", "execute_campaign", "single_post", "asset"],
    // single-post now honours input.contentId by skipping draftStep and
    // entering the revision loop against the existing content row. The
    // redraft button + retry-on-max_revisions rely on this flag.
    supportsContentRevision: true,
  },

  async start(input, ctx) {
    if (input.kind === "single_post") {
      return startSinglePost(input, ctx.workflowRunId);
    }
    if (input.kind === "campaign") {
      return startCampaignPlan(input, ctx.workflowRunId);
    }
    if (input.kind === "execute_campaign") {
      return startExecuteCampaign(input, ctx.workflowRunId);
    }
    if (input.kind === "asset") {
      return startAsset(input, ctx.workflowRunId);
    }
    throw new Error(`vercel engine does not support kind=${input.kind} yet`);
  },
};

async function startSinglePost(
  input: StartInput,
  workflowRunId: string,
): Promise<{ engineRunRef: string | null }> {
  const channel: Channel = (input.channel as Channel) ?? "linkedin";
  if (!CHANNELS.includes(channel)) {
    throw new Error(`unknown channel: ${channel}`);
  }
  const run = await start(singlePostWorkflow, [
    {
      request: input.request,
      workspaceId: input.workspaceId,
      channel,
      campaignId: input.campaignId,
      // When set, the workflow takes the resume path: skip draft + asset
      // generation, jump straight into the revision loop against the
      // existing content row.
      contentId: input.contentId,
      threadRef: input.threadRef,
      userId: input.userId ?? "admin",
      model: input.model as LlmModel | undefined,
      workflowRunId,
      inspirationImagePath: input.inspirationImagePath,
      media: input.media,
    },
  ]);
  return { engineRunRef: run.runId };
}

async function startCampaignPlan(
  input: StartInput,
  workflowRunId: string,
): Promise<{ engineRunRef: string | null }> {
  const run = await start(campaignPlanWorkflow, [
    {
      request: input.request,
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      threadRef: input.threadRef,
      userId: input.userId ?? "admin",
      model: input.model as LlmModel | undefined,
      workflowRunId,
    },
  ]);
  return { engineRunRef: run.runId };
}

async function startExecuteCampaign(
  input: StartInput,
  workflowRunId: string,
): Promise<{ engineRunRef: string | null }> {
  if (!input.campaignId) {
    throw new Error("execute_campaign requires a campaignId");
  }
  const run = await start(executeCampaignWorkflow, [
    {
      campaignId: input.campaignId,
      workspaceId: input.workspaceId,
      channel: input.channel as Channel | undefined,
      threadRef: input.threadRef,
      userId: input.userId ?? "admin",
      model: input.model as LlmModel | undefined,
      workflowRunId,
      itemIndices: input.itemIndices,
      itemMedia: input.itemMedia as WorkflowMedia[] | undefined,
      media: input.media,
    },
  ]);
  return { engineRunRef: run.runId };
}

async function startAsset(
  input: StartInput,
  workflowRunId: string,
): Promise<{ engineRunRef: string | null }> {
  const run = await start(assetWorkflow, [
    {
      request: input.request,
      workspaceId: input.workspaceId,
      contentId: input.contentId,
      threadRef: input.threadRef,
      userId: input.userId ?? "admin",
      model: input.model as LlmModel | undefined,
      workflowRunId,
      inspirationImagePath: input.inspirationImagePath,
      // The asset workflow is a single-image generator today. Video for
      // standalone assets would need a separate code path; for now we
      // refuse video at the API level so the user picks single_post for
      // video. `media` is intentionally not forwarded.
    },
  ]);
  return { engineRunRef: run.runId };
}
