import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { approvalHook } from "@/workflows/single-post";
import { errorResponse } from "@/lib/http";

// Recovery endpoint for stuck workflows. The decide route at
// app/api/approvals/[id]/route.ts persists the decision AND fires
// approvalHook.resume(...) — but if the resume call fails (network,
// runtime, etc.) the row ends up decided while the workflow is still
// suspended on the hook. This route lets the UI re-fire the hook with
// the already-stored decision. No DB writes — only the workflow runtime
// is touched.

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

    await approvalHook.resume(`approval:${id}`, {
      decision: approval.decision,
      reason: approval.reason ?? null,
    });

    return Response.json({ ok: true, decision: approval.decision });
  } catch (err) {
    return errorResponse(err);
  }
}
