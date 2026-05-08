// POST /api/generation-jobs/:id/steps — start a new step inside a job.
// Internal-only. Returns the inserted step id so the caller can patch it
// when the sub-agent finishes.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { assertInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const StartStep = z.object({
  name: z.enum(["strategist", "content", "asset", "analyst", "distributor"]),
  input: z.unknown().optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertInternal(request);
    const { id: jobId } = await context.params;
    const body = await parseJson(request, StartStep);

    const db = getDb();
    const [step] = await db
      .insert(schema.generationJobSteps)
      .values({
        jobId,
        name: body.name,
        status: "running",
        input: (body.input as object | null) ?? null,
      })
      .returning({ id: schema.generationJobSteps.id });

    // Keep the parent job's current_step pointer in sync so the UI doesn't
    // need to re-derive it from the latest step row.
    await db
      .update(schema.generationJobs)
      .set({ currentStep: body.name, updatedAt: new Date() })
      .where(eq(schema.generationJobs.id, jobId));

    return Response.json({ id: step!.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
