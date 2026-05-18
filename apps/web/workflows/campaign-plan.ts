import { and, desc, eq, gt } from "drizzle-orm";
import { CpClient } from "@marketing/cp-client";
import { runStrategist } from "@marketing/agents";
import { getDb, schema } from "@marketing/db";
import type { LlmModel } from "@marketing/shared-types";
import { resolveSubAgentModel } from "@/lib/workflow-engines";
import { finishRun } from "@/lib/workflow-engines/runs";

// Vercel campaign-plan workflow. Mirrors the manager's strategist path but
// runs durably under the Workflows runtime so it surfaces alongside
// single-post in the same dashboard. The work is one strategist step that
// the sub-agent's own tools (create_campaign, write_calendar) drive — we
// just instantiate it with the same CpClient the manager uses.

export type CampaignPlanInput = {
  request: string;
  /** Workspace scope; mandatory from PR 4. Threaded via dispatchStart. */
  workspaceId: string;
  campaignId?: string;
  userId?: string;
  threadRef?: string;
  model?: LlmModel;
  // Set by lib/workflow-engines so the workflow body can finalise the
  // matching workflow_runs row when the strategist returns.
  workflowRunId?: string;
};

export type CampaignPlanOutput = {
  campaignId: string | null;
  status: "completed" | "failed";
  summary: string;
};

export async function campaignPlanWorkflow(
  input: CampaignPlanInput,
): Promise<CampaignPlanOutput> {
  "use workflow";

  let strategistResult: Awaited<ReturnType<typeof runStrategistStep>> | null = null;
  try {
    strategistResult = await runStrategistStep(input);
    // The "successful" failure mode: the strategist generated text but never
    // hit a persistence tool, so nothing landed in the DB. Surfacing this as
    // a workflow failure prevents the UI from claiming a green run while
    // showing no campaign anywhere.
    if (!strategistResult.campaignId) {
      throw new Error(
        "strategist produced text but did not create or reference a campaign " +
          "(no create_campaign / update_campaign / write_calendar call was made). " +
          "Re-run with a brief that asks for a NEW campaign, or pass campaignId " +
          "if you meant to update an existing one.",
      );
    }
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "completed",
      campaignId: strategistResult.campaignId,
      result: strategistResult,
    });
    return { ...strategistResult, status: "completed" };
  } catch (err) {
    const message = (err as Error).message;
    // Persist whatever the strategist produced — the text is the most
    // valuable thing in the run, even if the workflow failed loud.
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "failed",
      error: message,
      result: strategistResult,
    });
    throw err;
  }
}

async function runStrategistStep(input: CampaignPlanInput): Promise<{
  campaignId: string | null;
  summary: string;
}> {
  "use step";

  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  // workspaceId on the client makes every CP call land in the user's
  // workspace via the x-workspace-id header. Without it, internal routes
  // silently default to the Legacy workspace — that's the bug that hid all
  // strategist-created campaigns from the user's Campaigns page.
  const cp = new CpClient({
    baseUrl,
    internalToken,
    workspaceId: input.workspaceId,
  });

  // Capture the cutoff before the strategist runs so we can find any
  // campaign it creates via its create_campaign tool. runStrategist only
  // returns model text, not the id of any row it inserted.
  const cutoff = new Date();

  const summary = await runStrategist({
    request: input.request,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    cp,
    model: await resolveSubAgentModel("strategist", input.model),
  });

  let campaignId = input.campaignId ?? null;
  if (!campaignId) {
    const db = getDb();
    const [created] = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.workspaceId, input.workspaceId),
          gt(schema.campaigns.createdAt, cutoff),
        ),
      )
      .orderBy(desc(schema.campaigns.createdAt))
      .limit(1);
    if (created) campaignId = created.id;
  }

  return { campaignId, summary };
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
