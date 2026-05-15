// POST /api/workflow-runs/start
//
// Unified, engine-agnostic dispatch endpoint. Engine is resolved from the
// global `settings.workflow_engine` row — clients no longer pick per-call.
// The dispatcher opens a workflow_runs row, then delegates to that engine's
// adapter. Replaces the divergent /api/generation-jobs/start (custom-only)
// and /api/workflows/single-post (vercel-only) callers — both routes still
// exist for back-compat but the UI now goes through here.
//
// `engine` is accepted on the body for internal callers that need to
// override (e.g. forcing a specific engine for migrations); user-facing
// flows omit it and accept the global default.

import { z } from "zod";
import { CHANNELS, LLM_MODELS } from "@marketing/shared-types";
import { errorResponse, parseJson } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import {
  dispatchStart,
  getDefaultWorkflowEngine,
  getDefaultWorkflowModel,
  getEngine,
} from "@/lib/workflow-engines";
import { LEGACY_WORKSPACE_ID, getWorkspaceContext } from "@/lib/billing";

const Body = z.object({
  engine: z.enum(["vercel", "cloudflare"]).optional(),
  kind: z.enum(["campaign", "single_post", "asset"]),
  request: z.string().min(1).max(8000),
  campaignId: z.string().uuid().optional(),
  contentId: z.string().uuid().optional(),
  channel: z.enum(CHANNELS).optional(),
  threadRef: z.string().optional(),
  model: z.enum(LLM_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
});

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

    const engineId = input.engine ?? (await getDefaultWorkflowEngine());
    const engine = getEngine(engineId);

    if (input.contentId && !engine.capability.supportsContentRevision) {
      return Response.json(
        {
          error:
            `The configured workflow engine (${engine.label}) cannot revise an ` +
            `existing content item in place. No engine currently supports it ` +
            `since Phase 4 cutover; revise by re-running run_content via the ` +
            `chat orchestrator with contentId.`,
        },
        { status: 400 },
      );
    }

    if (
      input.kind === "single_post" &&
      !input.campaignId &&
      engineId !== "vercel"
    ) {
      return Response.json(
        { error: `campaignId is required for single_post on the ${engine.label} engine` },
        { status: 400 },
      );
    }

    // Per-run model wins; otherwise fall back to the global workflow_model
    // setting so workflows that don't self-resolve (single-post's draft
    // step, asset workflow, custom-engine proxy) still respect the picker.
    const model = input.model ?? (await getDefaultWorkflowModel());

    const result = await dispatchStart(engineId, {
      kind: input.kind,
      workspaceId,
      request: input.request,
      campaignId: input.campaignId,
      contentId: input.contentId,
      channel: input.channel,
      threadRef: input.threadRef,
      model,
      userId: actor.id ?? "manual",
    });

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
