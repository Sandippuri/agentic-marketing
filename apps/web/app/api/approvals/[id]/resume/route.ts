import { and, desc, eq } from "drizzle-orm";
import { HookNotFoundError } from "workflow/internal/errors";
import { getDb, schema } from "@marketing/db";
import { approvalHook } from "@/workflows/single-post";
import { finishRun } from "@/lib/workflow-engines/runs";
import { errorResponse } from "@/lib/http";

// Recovery endpoint for stuck workflows. The decide route at
// app/api/approvals/[id]/route.ts persists the decision AND fires
// approvalHook.resume(...) — but if the resume call fails (network,
// runtime, etc.) the row ends up decided while the workflow is still
// suspended on the hook. This route lets the UI re-fire the hook with
// the already-stored decision.
//
// If the workflow runtime no longer has the hook (HookNotFoundError —
// the hook was already consumed, or the run terminated before reaching
// it), we reconcile the workflow_runs row directly so it stops being
// flagged as stuck. The approval's decision drives the terminal status.

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const db = getDb();

    const [approval] = await db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, id))
      .limit(1);
    if (!approval) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (!approval.decision) {
      // Use the regular decide endpoint when the approval is still pending.
      return Response.json({ error: "not_decided" }, { status: 409 });
    }

    try {
      await approvalHook.resume(`approval:${id}`, {
        decision: approval.decision,
        reason: approval.reason ?? null,
      });
      return Response.json({ ok: true, decision: approval.decision });
    } catch (err) {
      if (!HookNotFoundError.is(err)) {
        // Surface the real workflow-runtime error to the UI instead of a
        // generic 500. Log the full error so the dev-server console still
        // gets the stack for diagnosis.
        console.error(
          `[approvals.resume] approvalHook.resume failed for ${id}:`,
          err,
        );
        const name = err instanceof Error ? err.name : "Error";
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: "hook_resume_failed", name, message },
          { status: 502 },
        );
      }

      // Hook is gone — either already consumed or the workflow terminated
      // before reaching it. Reconcile the workflow_runs row so the stuck
      // list clears. Pick the most recent running run for this content.
      const [run] = await db
        .select({ id: schema.workflowRuns.id })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.contentId, approval.contentId),
            eq(schema.workflowRuns.status, "running"),
          ),
        )
        .orderBy(desc(schema.workflowRuns.createdAt))
        .limit(1);

      if (!run) {
        // Nothing to reconcile — hook is gone and no running row remains.
        return Response.json({
          ok: true,
          decision: approval.decision,
          reconciled: false,
          note: "hook_not_found_no_running_run",
        });
      }

      const terminalStatus =
        approval.decision === "approved" ? "completed" : "cancelled";
      await finishRun(run.id, {
        status: terminalStatus,
        contentId: approval.contentId,
        error: "hook_not_found_reconciled",
      });

      return Response.json({
        ok: true,
        decision: approval.decision,
        reconciled: true,
        workflowRunId: run.id,
        terminalStatus,
      });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
