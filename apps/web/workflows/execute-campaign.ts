import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { start } from "workflow/api";
import { getDb, schema } from "@marketing/db";
import {
  CHANNELS,
  type Channel,
  type LlmModel,
  type WorkflowMedia,
} from "@marketing/shared-types";
import { resolveSubAgentModel } from "@/lib/workflow-engines";
import { finishRun } from "@/lib/workflow-engines/runs";
import { singlePostWorkflow } from "./single-post";

// Fan-out workflow: takes an existing campaign (with its calendar already
// written by the Strategist) and fires one single-post workflow per item.
// Replaces the failure mode where a user asked "generate all 14 posts" and
// the Strategist just emitted prose without writing anything to the DB.
//
// We don't wait for the children — each child has its own approval gate
// that can take minutes to days. Returning early lets the parent run close,
// while each child shows up as its own row on the Workflow Runs page.

export type ExecuteCampaignInput = {
  campaignId: string;
  /** Workspace scope. Threaded by the dispatcher. */
  workspaceId: string;
  /** Optional override; otherwise inferred from each calendar item. */
  channel?: Channel;
  userId?: string;
  threadRef?: string;
  model?: LlmModel;
  /** Set by the unified dispatcher so the workflow body can finalise the run row. */
  workflowRunId?: string;
  /**
   * Indices of the calendar items the user explicitly approved in the
   * pre-flight checklist. Required — leaving it empty refuses the run so
   * we never silently fan out 14 generations at once.
   */
  itemIndices?: number[];
  /**
   * Per-item media override, parallel array to `itemIndices` (same length,
   * same order). Missing or "auto" falls back to `media` and then to the
   * legacy behavior. Lets a 14-item batch mix image-only / video / both
   * per row.
   */
  itemMedia?: WorkflowMedia[];
  /**
   * Default media for items that don't carry a per-item override. Forwarded
   * to each spawned singlePostWorkflow.
   */
  media?: WorkflowMedia;
};

export type ExecuteCampaignOutput = {
  campaignId: string;
  spawned: number;
  skipped: number;
  status: "completed" | "failed";
};

// Calendar items are jsonb so we shape-check before fanning out. Items that
// fail the schema are skipped (not fatal) — partial fan-out is more useful
// than refusing the whole batch because one row is malformed.
const CalendarItem = z.object({
  title: z.string().min(1),
  type: z.enum([
    "blog",
    "linkedin",
    "x_thread",
    "x_post",
    "email",
    "instagram",
    "facebook",
  ]),
  stage: z.enum(["pull", "explain", "reinforce", "push"]).optional(),
  phase: z
    .enum(["buildup", "launch", "post_launch"])
    .optional(),
  scheduledFor: z.string().optional(),
  brief: z.string().optional(),
});

const TYPE_TO_CHANNEL: Record<z.infer<typeof CalendarItem>["type"], Channel> = {
  blog: "internal_blog",
  linkedin: "linkedin",
  x_post: "x",
  x_thread: "x",
  email: "email_hubspot",
  instagram: "instagram",
  facebook: "facebook",
};

export async function executeCampaignWorkflow(
  input: ExecuteCampaignInput,
): Promise<ExecuteCampaignOutput> {
  "use workflow";

  try {
    const result = await spawnChildrenStep(input);
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "completed",
      campaignId: input.campaignId,
      result,
    });
    return { ...result, status: "completed" };
  } catch (err) {
    const message = (err as Error).message;
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "failed",
      error: message,
    });
    throw err;
  }
}

async function spawnChildrenStep(input: ExecuteCampaignInput): Promise<{
  campaignId: string;
  spawned: number;
  skipped: number;
}> {
  "use step";

  const db = getDb();
  const [campaign] = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      briefMd: schema.campaigns.briefMd,
      calendarJson: schema.campaigns.calendarJson,
    })
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.id, input.campaignId),
        eq(schema.campaigns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  if (!campaign) {
    throw new Error(
      `campaign ${input.campaignId} not found in workspace ${input.workspaceId}`,
    );
  }
  if (!Array.isArray(campaign.calendarJson) || campaign.calendarJson.length === 0) {
    throw new Error(
      `campaign ${campaign.name} has no calendar items — run the Campaign plan workflow first so the Strategist writes one`,
    );
  }

  const approvedList = input.itemIndices ?? [];
  const approved = new Set(approvedList);
  if (approved.size === 0) {
    throw new Error(
      "no calendar items approved — pick at least one item in the pre-flight checklist before starting the run",
    );
  }

  // Build an index→media map so per-item overrides survive the iteration
  // order over calendar items. We rebuild here rather than relying on a
  // parallel array because the loop below walks the full calendar, not just
  // the approved indices.
  const itemMediaMap = new Map<number, WorkflowMedia>();
  if (input.itemMedia && input.itemMedia.length === approvedList.length) {
    for (let n = 0; n < approvedList.length; n++) {
      const m = input.itemMedia[n];
      if (m) itemMediaMap.set(approvedList[n]!, m);
    }
  }

  const resolvedModel = await resolveSubAgentModel("content", input.model);
  let spawned = 0;
  let skipped = 0;

  const calendar = campaign.calendarJson as unknown[];
  for (let i = 0; i < calendar.length; i++) {
    if (!approved.has(i)) continue;
    const parsed = CalendarItem.safeParse(calendar[i]);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const item = parsed.data;
    const channel = input.channel ?? TYPE_TO_CHANNEL[item.type];
    if (!CHANNELS.includes(channel)) {
      skipped += 1;
      continue;
    }

    const request = buildBrief({
      title: item.title,
      stage: item.stage,
      phase: item.phase,
      scheduledFor: item.scheduledFor,
      itemBrief: item.brief,
      campaignName: campaign.name,
      campaignBriefMd: campaign.briefMd ?? null,
    });

    const perItemMedia = itemMediaMap.get(i) ?? input.media;
    await start(singlePostWorkflow, [
      {
        request,
        workspaceId: input.workspaceId,
        channel,
        campaignId: input.campaignId,
        threadRef: input.threadRef,
        userId: input.userId ?? "admin",
        model: resolvedModel,
        media: perItemMedia,
      },
    ]);
    spawned += 1;
  }

  return { campaignId: input.campaignId, spawned, skipped };
}

function buildBrief(args: {
  title: string;
  stage?: string;
  phase?: string;
  scheduledFor?: string;
  itemBrief?: string;
  campaignName: string;
  campaignBriefMd: string | null;
}): string {
  // Compact prompt for the single-post draft step. The campaign brief is
  // included as ground truth so the draft inherits the campaign's voice and
  // CTA without a separate retrieval pass.
  const lines = [
    `Write a ${args.scheduledFor ? `(scheduled ${args.scheduledFor}) ` : ""}post titled: "${args.title}".`,
    `Campaign: ${args.campaignName}.`,
  ];
  if (args.stage) lines.push(`Stage: ${args.stage}.`);
  if (args.phase) lines.push(`Phase: ${args.phase}.`);
  if (args.itemBrief) lines.push("", `Brief: ${args.itemBrief}`);
  if (args.campaignBriefMd) {
    lines.push("", "Campaign brief (for voice + CTA):", args.campaignBriefMd);
  }
  return lines.join("\n");
}

async function finishWorkflowRunStep(payload: {
  workflowRunId?: string;
  status: "completed" | "failed" | "cancelled";
  campaignId?: string | null;
  error?: string | null;
  result?: unknown;
}): Promise<void> {
  "use step";
  if (!payload.workflowRunId) return;
  await finishRun(payload.workflowRunId, {
    status: payload.status,
    campaignId: payload.campaignId ?? null,
    error: payload.error ?? null,
    result: payload.result,
  });
}
