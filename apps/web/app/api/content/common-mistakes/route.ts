/**
 * POST /api/content/common-mistakes
 *
 * Accepts a pre-computed embedding vector and returns rejected / changes_requested
 * agent_feedback rows whose AI draft is semantically closest to that vector.
 *
 * The Content sub-agent calls this before drafting in problem areas where the
 * model has been edited or rejected before, so it can avoid repeating the same
 * mistakes. Rationale lives in the plan §Phase 11 — `findCommonMistakes`.
 *
 * Phase 11 — wired but designed to silently return empty until ~50+ rejections
 * have been embedded. No backfill is required: the embed worker writes a
 * 'rejected_draft' row for each new rejection going forward.
 */

import { z } from "zod";
import { sql, and, eq, inArray } from "drizzle-orm";
import { getDb, schema, embeddings } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const CommonMistakesRequest = z.object({
  vector: z.array(z.number()).length(1536),
  /** Embedding model id; filters embeddings.model when set. See similar/route.ts. */
  model: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional().default(5),
});

export async function POST(request: Request) {
  try {
    if (!isInternal(request)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const input = await parseJson(request, CommonMistakesRequest);
    const db = getDb();

    const vectorLiteral = `[${input.vector.join(",")}]`;

    /**
     * Query plan:
     * 1. From embeddings filtered to source_type='rejected_draft'.
     * 2. Inner-join agent_feedback on source_id = agent_feedback.id::text.
     * 3. Filter to decisions in ('rejected', 'changes_requested') — defensive,
     *    even though the embed pipeline only writes those rows.
     * 4. Order by cosine distance, limit N.
     */
    const rows = await db
      .select({
        feedbackId: schema.agentFeedback.id,
        contentId: schema.agentFeedback.contentId,
        aiDraftMd: schema.agentFeedback.aiDraftMd,
        decision: schema.agentFeedback.decision,
        reason: schema.agentFeedback.reason,
        editDistance: schema.agentFeedback.editDistance,
        decidedAt: schema.agentFeedback.decidedAt,
        distance: sql<number>`(${embeddings.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)})`,
      })
      .from(embeddings)
      .innerJoin(
        schema.agentFeedback,
        and(
          eq(embeddings.sourceType, "rejected_draft"),
          sql`${embeddings.sourceId} = ${schema.agentFeedback.id}::text`,
        ),
      )
      .where(
        and(
          inArray(schema.agentFeedback.decision, ["rejected", "changes_requested"]),
          input.model ? eq(embeddings.model, input.model) : sql`true`,
        ),
      )
      .orderBy(
        sql`(${embeddings.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)})`,
      )
      .limit(input.limit ?? 5);

    return Response.json(
      rows.map((r) => ({
        feedback_id: r.feedbackId,
        content_id: r.contentId,
        ai_draft_md: r.aiDraftMd,
        decision: r.decision,
        reason: r.reason,
        edit_distance: r.editDistance,
        decided_at: r.decidedAt,
        similarity: r.distance != null ? 1 - r.distance : null,
      })),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
