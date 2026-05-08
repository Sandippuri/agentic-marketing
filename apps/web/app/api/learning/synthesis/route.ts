/**
 * POST /api/learning/synthesis — manually trigger a learning synthesis run.
 *
 * Authenticated admin endpoint. The cron route at /api/cron/learning-
 * synthesis runs weekly automatically; this is for "synthesise now" from
 * the admin UI.
 */
import { z } from "zod";
import { start } from "workflow/api";
import { learningSynthesisWorkflow } from "@/workflows/learning-synthesis";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  windowDays: z.number().int().min(1).max(365).optional(),
  collectionSlug: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    await getRequestActor();
    const raw = await request.json().catch(() => ({}));
    const parsed = Body.parse(raw ?? {});
    const run = await start(learningSynthesisWorkflow, [
      {
        windowDays: parsed.windowDays,
        collectionSlug: parsed.collectionSlug,
      },
    ]);
    return Response.json({ runId: run.runId, status: "started" });
  } catch (err) {
    return errorResponse(err);
  }
}
