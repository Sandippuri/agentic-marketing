// PATCH /api/generation-jobs/:id — internal-only update of job state
// (status, kind upgrade, current step pointer, linked campaign/content).
// Used by the manager after each sub-agent run and at orchestrator end.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { assertInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const PatchGenerationJob = z.object({
  status: z.enum(["running", "completed", "failed"]).optional(),
  kind: z
    .enum(["campaign", "single_post", "asset", "analysis", "publish", "research", "other"])
    .optional(),
  currentStep: z
    .enum(["strategist", "content", "asset", "analyst", "distributor", "researcher"])
    .nullable()
    .optional(),
  campaignId: z.string().uuid().nullable().optional(),
  contentId: z.string().uuid().nullable().optional(),
  error: z.string().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertInternal(request);
    const { id } = await context.params;
    const input = await parseJson(request, PatchGenerationJob);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (input.status !== undefined) update.status = input.status;
    if (input.kind !== undefined) update.kind = input.kind;
    if (input.currentStep !== undefined) update.currentStep = input.currentStep;
    if (input.campaignId !== undefined) update.campaignId = input.campaignId;
    if (input.contentId !== undefined) update.contentId = input.contentId;
    if (input.error !== undefined) update.error = input.error;
    if (input.completedAt !== undefined) {
      update.completedAt = input.completedAt ? new Date(input.completedAt) : null;
    }

    const db = getDb();
    await db
      .update(schema.generationJobs)
      .set(update)
      .where(eq(schema.generationJobs.id, id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
