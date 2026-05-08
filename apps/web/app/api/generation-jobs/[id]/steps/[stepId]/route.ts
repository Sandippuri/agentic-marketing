// PATCH /api/generation-jobs/:id/steps/:stepId — finish a step.
// Stores the sub-agent's output (or error) and stamps completed_at.

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { assertInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const FinishStep = z.object({
  status: z.enum(["succeeded", "failed"]),
  output: z.unknown().optional(),
  error: z.string().nullable().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; stepId: string }> },
) {
  try {
    assertInternal(request);
    const { id: jobId, stepId } = await context.params;
    const body = await parseJson(request, FinishStep);

    const db = getDb();
    await db
      .update(schema.generationJobSteps)
      .set({
        status: body.status,
        output: (body.output as object | null) ?? null,
        error: body.error ?? null,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.generationJobSteps.id, stepId),
          eq(schema.generationJobSteps.jobId, jobId),
        ),
      );
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
