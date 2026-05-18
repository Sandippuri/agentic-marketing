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
import { CHANNELS, LLM_MODELS, WORKFLOW_MEDIA } from "@marketing/shared-types";
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
  kind: z.enum(["campaign", "execute_campaign", "single_post", "asset"]),
  // execute_campaign drives off the campaign's existing calendar, so the
  // user doesn't need to type a brief — but the workflow_runs row + audit
  // log expect a request string. The form falls back to a sentinel.
  request: z.string().min(1).max(8000),
  campaignId: z.string().uuid().optional(),
  contentId: z.string().uuid().optional(),
  channel: z.enum(CHANNELS).optional(),
  threadRef: z.string().optional(),
  model: z.enum(LLM_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
  // Storage path returned by /api/uploads/inspiration-images. Constrained
  // to the inspiration/ prefix so a tampered request can't redirect the
  // image model at an arbitrary asset key.
  inspirationImagePath: z
    .string()
    .min(1)
    .max(500)
    .refine(
      (p) => p.startsWith("inspiration/"),
      "must be under inspiration/",
    )
    .optional(),
  /**
   * execute_campaign — explicit user approval of which calendar items to run.
   * Bounded so a misbehaving client can't fan out hundreds of runs in one
   * call. Empty means refuse.
   */
  itemIndices: z.array(z.number().int().nonnegative().max(500)).max(50).optional(),
  /**
   * Per-item media selection for execute_campaign. Same length + order as
   * `itemIndices`. Omitted entries (or whole field) default to "auto" so
   * existing callers keep working. Treated as a hard override per-item.
   */
  itemMedia: z
    .array(z.enum(WORKFLOW_MEDIA))
    .max(50)
    .optional(),
  /**
   * User-chosen media for single_post / asset / execute_campaign-default.
   * Hard override — see WorkflowMedia docs. Omitted = "auto".
   */
  media: z.enum(WORKFLOW_MEDIA).optional(),
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
    if (input.kind === "execute_campaign") {
      if (!input.campaignId) {
        return Response.json(
          { error: "campaignId is required for execute_campaign" },
          { status: 400 },
        );
      }
      if (!input.itemIndices || input.itemIndices.length === 0) {
        return Response.json(
          { error: "pick at least one calendar item to run" },
          { status: 400 },
        );
      }
      if (
        input.itemMedia &&
        input.itemMedia.length !== input.itemIndices.length
      ) {
        return Response.json(
          {
            error:
              "itemMedia must have the same length as itemIndices when provided",
          },
          { status: 400 },
        );
      }
    }

    // The standalone `asset` workflow is image-only today — refuse video
    // there with a hint to use single_post. Without this guard the request
    // would silently produce an image despite the user picking video.
    if (
      input.kind === "asset" &&
      (input.media === "video" || input.media === "both")
    ) {
      return Response.json(
        {
          error:
            "The standalone asset workflow only generates images. For video, use a single_post run (or attach to an existing content item).",
        },
        { status: 400 },
      );
    }

    // Refuse video-forced runs up-front when video generation is infeasible,
    // so the user sees the actual reason instead of getting a silent
    // image-only result. The per-item media (execute_campaign) is checked
    // the same way — any video/both forces the same gate.
    const wantsVideo =
      input.media === "video" ||
      input.media === "both" ||
      input.itemMedia?.some((m) => m === "video" || m === "both") === true;
    if (wantsVideo) {
      const reason = await videoInfeasibilityReason();
      if (reason) {
        return Response.json({ error: reason }, { status: 400 });
      }
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
      inspirationImagePath: input.inspirationImagePath,
      itemIndices: input.itemIndices,
      itemMedia: input.itemMedia,
      media: input.media,
    });

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

// Returns a human-readable reason when the workspace can't generate video
// (env or settings), or null when video is good to go. Mirrors the gates
// inside lib/video-variant.ts so the form gets the exact same verdict
// before submit instead of discovering it after the run starts.
async function videoInfeasibilityReason(): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) {
    return "Video generation requires GEMINI_API_KEY — set it on the server before requesting video.";
  }
  try {
    const { getDb, schema } = await import("@marketing/db");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "video_generation_enabled"))
      .limit(1);
    if (row?.value === false) {
      return "Video generation is disabled in Settings (set video_generation_enabled=true to opt in).";
    }
    return null;
  } catch {
    // Settings unreachable — don't block; the workflow's own gate will catch it.
    return null;
  }
}
