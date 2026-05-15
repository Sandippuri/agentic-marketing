// POST /api/generation-jobs/start
//
// User-invoked workflow trigger. Phase 4 cutover: instead of proxying to the
// Manager, we dispatch the run via the unified workflow-engines layer (Vercel
// is the default; Cloudflare is also wired). The engine adapter creates the
// workflow_runs row, calls the underlying SDK, and returns the run id.

import { z } from "zod";
import pino from "pino";
import { CHANNELS } from "@marketing/shared-types";
import { errorResponse, parseJson } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import { dispatchStart, getDefaultWorkflowEngine } from "@/lib/workflow-engines";
import { getWorkspaceContext } from "@/lib/billing";

const log = pino({ name: "generation-jobs.start" });

const StartWorkflow = z
  .object({
    kind: z.enum(["campaign", "single_post", "asset"]),
    request: z.string().min(1).max(8000),
    campaignId: z.string().uuid().optional(),
    contentId: z.string().uuid().optional(),
    channel: z.enum(CHANNELS).optional(),
    model: z.string().optional(),
  })
  .refine((v) => v.kind !== "single_post" || !!v.campaignId, {
    message: "campaignId is required for single_post",
  });

export async function POST(request: Request) {
  try {
    const actor = await getRequestActor();
    const ctx = await getWorkspaceContext();
    const input = await parseJson(request, StartWorkflow);

    const engineId = await getDefaultWorkflowEngine();
    const result = await dispatchStart(engineId, {
      kind: input.kind,
      workspaceId: ctx.workspaceId,
      request: input.request,
      campaignId: input.campaignId,
      contentId: input.contentId,
      channel: input.channel,
      model: input.model,
      userId: actor.id ?? "manual",
    });

    log.info(
      { engine: result.engine, runId: result.workflowRunId },
      "generation-jobs.start dispatched",
    );

    return Response.json({
      jobId: result.engineRunRef ?? null,
      workflowRunId: result.workflowRunId,
      engine: result.engine,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
