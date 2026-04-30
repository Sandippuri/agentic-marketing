import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { APPROVAL_DECISIONS } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { assertContentTransition } from "@/lib/state-machine";
import { errorResponse, parseJson } from "@/lib/http";

const Decide = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  reason: z.string().max(2000).optional(),
  // For chat-driven approvals the Manager forwards the human's user id.
  decidedBy: z.string().uuid().optional(),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, Decide);
    const db = getDb();

    const result = await withAudit(
      { db, actor, action: `approval.${input.decision}`, entityType: "approvals" },
      async () => {
        const [row] = await db
          .select()
          .from(schema.approvals)
          .where(eq(schema.approvals.id, id))
          .limit(1);
        return row ?? null;
      },
      async () => {
        const [approval] = await db
          .select()
          .from(schema.approvals)
          .where(eq(schema.approvals.id, id))
          .limit(1);
        if (!approval) throw new Error("not_found");
        if (approval.decision) throw new Error("already_decided");

        const [content] = await db
          .select()
          .from(schema.contentItems)
          .where(eq(schema.contentItems.id, approval.contentId))
          .limit(1);
        if (!content) throw new Error("not_found");

        // State-machine: in_review -> approved | draft (changes_requested / rejected)
        const target =
          input.decision === "approved" ? "approved" : "draft";
        assertContentTransition(content.status, target);

        await db
          .update(schema.contentItems)
          .set({ status: target, updatedAt: new Date() })
          .where(eq(schema.contentItems.id, approval.contentId));

        const [updated] = await db
          .update(schema.approvals)
          .set({
            decision: input.decision,
            decidedAt: new Date(),
            decidedBy: input.decidedBy ?? actor.id ?? null,
            reason: input.reason ?? null,
          })
          .where(eq(schema.approvals.id, id))
          .returning();
        return updated!;
      },
    );
    return Response.json(result);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === "not_found") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (err.message === "already_decided") {
        return Response.json({ error: "already_decided" }, { status: 409 });
      }
    }
    return errorResponse(err);
  }
}
