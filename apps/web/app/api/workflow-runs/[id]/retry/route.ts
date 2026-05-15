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
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CHANNELS } from "@marketing/shared-types";
import { errorResponse } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { dispatchStart, getEngine } from "@/lib/workflow-engines";
import { LEGACY_WORKSPACE_ID } from "@/lib/billing";

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
        workspaceId: schema.workflowRuns.workspaceId,
        // workflowRuns.contentId is stamped by draftStep on first run, so a
        // max_revisions/changes_requested cancelled run carries its draft
        // here even though the original input had no contentId. We use this
        // below to flip retry into "resume revising" mode automatically.
        contentId: schema.workflowRuns.contentId,
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

    // Resume-on-retry decision: when the prior run created a content row
    // and the reviewer left changes_requested feedback on it, the right
    // semantic for "Retry" is to continue revising — not orphan the draft
    // and start fresh. We forward contentId only when the content is still
    // revisable (draft/in_review) AND there's a real reason for the
    // workflow's revise step to act on. Anything else falls through to a
    // fresh start.
    let resumeContentId: string | undefined =
      typeof snapshot.contentId === "string" ? snapshot.contentId : undefined;
    if (!resumeContentId && run.contentId) {
      const [content] = await db
        .select({ status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(eq(schema.contentItems.id, run.contentId))
        .limit(1);
      if (content && (content.status === "draft" || content.status === "in_review")) {
        const [latest] = await db
          .select({ decision: schema.approvals.decision })
          .from(schema.approvals)
          .where(
            and(
              eq(schema.approvals.contentId, run.contentId),
              eq(schema.approvals.decision, "changes_requested"),
            ),
          )
          .orderBy(desc(schema.approvals.decidedAt))
          .limit(1);
        if (latest) resumeContentId = run.contentId;
      }
    }

    // If the engine can't revise in place, drop contentId rather than
    // erroring — the retry then becomes an honest fresh draft instead of a
    // 400 in the user's face.
    if (resumeContentId && !engine.capability.supportsContentRevision) {
      resumeContentId = undefined;
    }

    const parsed = InputShape.parse({
      kind: snapshot.kind ?? run.kind,
      request: snapshot.request ?? run.request,
      campaignId: snapshot.campaignId,
      contentId: resumeContentId,
      channel: snapshot.channel,
      threadRef: snapshot.threadRef,
    });

    const result = await dispatchStart(run.engine as "vercel" | "cloudflare", {
      kind: parsed.kind,
      // Workspace inherited from the original run so a retry can't be
      // hijacked to a different tenant by a switching session.
      workspaceId: run.workspaceId ?? LEGACY_WORKSPACE_ID,
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
