import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema, levenshtein } from "@marketing/db";
import { APPROVAL_DECISIONS } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { assertContentTransition } from "@/lib/state-machine";
import { errorResponse, parseJson } from "@/lib/http";
import { enqueueEmbedding, enqueueRejectedDraftEmbedding } from "@/lib/embedding-queue";
import { approvalHook } from "@/workflows/single-post";

// Reason is required for any non-approval decision so the learning loop has
// something to embed — a bare "rejected" with no explanation produces a
// rejected_draft embedding keyed on `null`, which findCommonMistakes can't
// use to steer future drafts away from the same miss.
const Decide = z
  .object({
    decision: z.enum(APPROVAL_DECISIONS),
    reason: z.string().trim().min(1).max(2000).optional(),
    // For chat-driven approvals the Manager forwards the human's user id.
    decidedBy: z.string().uuid().optional(),
  })
  .refine((v) => v.decision === "approved" || !!v.reason, {
    message: "reason is required when decision is not 'approved'",
    path: ["reason"],
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

        // --- Phase 11 / Phase 4 add-on ---
        // Capture the AI draft vs. final human version for every decision.
        // Fetch the current revision to snapshot the AI draft.
        const [revision] = content.currentRevisionId
          ? await db
              .select()
              .from(schema.contentRevisions)
              .where(eq(schema.contentRevisions.id, content.currentRevisionId))
              .limit(1)
          : [undefined];

        const aiDraftMd = revision?.bodyMd ?? content.bodyMd;
        const humanFinalMd =
          input.decision === "approved" ? content.bodyMd : null;

        const [feedback] = await db
          .insert(schema.agentFeedback)
          .values({
            workspaceId: content.workspaceId,
            contentId: approval.contentId,
            revisionId: content.currentRevisionId ?? null,
            aiDraftMd,
            humanFinalMd,
            decision: input.decision,
            editDistance:
              humanFinalMd !== null
                ? levenshtein(aiDraftMd, humanFinalMd)
                : null,
            decidedBy: input.decidedBy ?? actor.id ?? null,
            decidedAt: new Date(),
            reason: input.reason ?? null,
          })
          .returning({ id: schema.agentFeedback.id });

        if (input.decision === "approved") {
          // Approved → embed the content so findSimilarContent can return it.
          await enqueueEmbedding(approval.contentId).catch(() => {
            // Non-critical: embedding can be backfilled later.
          });
        } else if (feedback?.id) {
          // Rejected / changes_requested → embed the AI draft + reason so
          // findCommonMistakes can later surface this miss.
          await enqueueRejectedDraftEmbedding(feedback.id).catch(() => {
            // Non-critical: rejected embeddings can be backfilled later.
          });
        }

        return updated!;
      },
    );

    // Phase 1 of the Vercel migration: if a single-post workflow is
    // suspended on this approval's hook token, resume it. No-op when the
    // approval came from a non-workflow path (e.g. legacy chat flow).
    // Surface failures so the caller can recover via /approvals' stuck
    // section instead of silently leaving a hung workflow.
    let hookResumed = true;
    let hookError: string | null = null;
    try {
      await approvalHook.resume(`approval:${id}`, {
        decision: input.decision,
        reason: input.reason ?? null,
      });
    } catch (err) {
      hookResumed = false;
      hookError = err instanceof Error ? err.message : String(err);
      console.error(
        `[approvals.decide] approvalHook.resume failed for ${id}: ${hookError}`,
      );
    }

    return Response.json({ ...result, hookResumed, hookError });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === "not_found") {
        return Response.json(
          {
            error: "not_found",
            message: "This approval no longer exists. It may have been resolved by someone else — refresh the list.",
          },
          { status: 404 },
        );
      }
      if (err.message === "already_decided") {
        return Response.json(
          {
            error: "already_decided",
            message: "This approval has already been decided by another reviewer. Refresh to see the current state.",
          },
          { status: 409 },
        );
      }
    }
    return errorResponse(err);
  }
}
