// POST /api/workflow-runs/[id]/retry
//
// Re-dispatches a previously failed/cancelled workflow run using the args
// snapshotted onto workflow_runs.input. The model is intentionally NOT
// reused from the snapshot — dispatchStart re-resolves it from current
// settings so an admin who flipped Settings → Models in response to the
// original failure (e.g. switching off an out-of-quota provider) sees the
// new choice take effect on the next attempt. Engine is preserved.
//
// Refuses to retry runs that are still running/queued so a misclick can't
// fan out duplicates while the original is alive.
//
// On success: returns the same shape as /api/workflow-runs/start so the
// client can navigate or refresh into the new run row.
//
// Note (Phase 1 of the Vercel migration): the source run's row is left
// alone — `failed` stays `failed`. The retry creates a fresh workflow_runs
// row, keeping the audit trail intact.
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CHANNELS } from "@marketing/shared-types";
import { errorResponse } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { dispatchStart, getEngine } from "@/lib/workflow-engines";

const InputShape = z.object({
  kind: z.enum(["campaign", "single_post", "asset"]),
  request: z.string().min(1).max(8000),
  campaignId: z.string().uuid().optional(),
  contentId: z.string().uuid().optional(),
  channel: z.enum(CHANNELS).optional(),
  threadRef: z.string().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();

    const db = getDb();
    const [run] = await db
      .select({
        id: schema.workflowRuns.id,
        engine: schema.workflowRuns.engine,
        kind: schema.workflowRuns.kind,
        status: schema.workflowRuns.status,
        input: schema.workflowRuns.input,
        request: schema.workflowRuns.request,
      })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, id))
      .limit(1);

    if (!run) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (run.status === "running" || run.status === "queued") {
      return Response.json(
        {
          error: "still_active",
          message:
            "This run is still " +
            run.status +
            ". Cancel it or wait for the engine to mark it terminal before retrying.",
        },
        { status: 409 },
      );
    }

    // Phase 4 cutover removed the "custom" engine. Legacy workflow_runs rows
    // tagged with that engine can't be retried in place — surface a clear
    // error and let the user re-run the request via the orchestrator.
    if (run.engine === "custom") {
      return Response.json(
        {
          error: "engine_removed",
          message:
            "The 'custom' engine was removed in Phase 4. Re-run this request " +
            "from chat — the orchestrator will dispatch via Vercel.",
        },
        { status: 410 },
      );
    }
    const engine = getEngine(run.engine as "vercel" | "cloudflare");
    if (!engine.capability.available) {
      return Response.json(
        {
          error: "engine_unavailable",
          message: `Engine ${run.engine} is no longer available.`,
        },
        { status: 409 },
      );
    }

    // Older rows pre-dating the input snapshot may have null/empty input.
    // Fall back to the row's `request` + `kind` so retry still works on
    // legacy runs, but anything else (campaignId, channel, threadRef) is
    // unrecoverable in that case.
    const snapshot = (run.input ?? {}) as Record<string, unknown>;
    const parsed = InputShape.parse({
      kind: snapshot.kind ?? run.kind,
      request: snapshot.request ?? run.request,
      campaignId: snapshot.campaignId,
      contentId: snapshot.contentId,
      channel: snapshot.channel,
      threadRef: snapshot.threadRef,
    });

    const result = await dispatchStart(run.engine as "vercel" | "cloudflare", {
      kind: parsed.kind,
      request: parsed.request,
      campaignId: parsed.campaignId,
      contentId: parsed.contentId,
      channel: parsed.channel,
      threadRef: parsed.threadRef,
      // Drop the snapshotted model — dispatchStart re-resolves from
      // current settings so a settings change between attempts takes
      // effect.
      model: undefined,
      userId: actor.id ?? "manual",
    });

    return Response.json({ ...result, retriedFrom: run.id });
  } catch (err) {
    return errorResponse(err);
  }
}
