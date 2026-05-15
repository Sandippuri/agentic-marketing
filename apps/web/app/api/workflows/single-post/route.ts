import { z } from "zod";
import { start } from "workflow/api";
import { CHANNELS, LLM_MODELS } from "@marketing/shared-types";
import { singlePostWorkflow } from "@/workflows/single-post";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";
import { getDefaultWorkflowModel } from "@/lib/workflow-engines";
import { LEGACY_WORKSPACE_ID, getWorkspaceContext } from "@/lib/billing";

const Body = z.object({
  request: z.string().min(1).max(8000),
  channel: z.enum(CHANNELS),
  campaignId: z.string().uuid().optional(),
  threadRef: z.string().optional(),
  model: z.enum(LLM_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
});

// POST /api/workflows/single-post
// Phase 1 trigger for the single-post workflow. Test-chat hits this when the
// user types `/workflow draft <prompt>`. Returns the run id so the caller
// can correlate (and so we can later show a status link).
export async function POST(request: Request) {
  try {
    const isInternalCall = isInternal(request);
    const actor = isInternalCall
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const workspaceId = isInternalCall
      ? LEGACY_WORKSPACE_ID
      : (await getWorkspaceContext()).workspaceId;
    const input = await parseJson(request, Body);

    const model = input.model ?? (await getDefaultWorkflowModel());
    const run = await start(singlePostWorkflow, [
      {
        request: input.request,
        workspaceId,
        channel: input.channel,
        campaignId: input.campaignId,
        threadRef: input.threadRef,
        userId: actor.id ?? "admin",
        model,
      },
    ]);

    return Response.json({ runId: run.runId, status: "started" });
  } catch (err) {
    return errorResponse(err);
  }
}
