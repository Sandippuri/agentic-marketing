/**
 * GET /api/learning/insights — aggregated agent_feedback signal.
 *
 * Query:
 *   windowDays?: number (default 30)
 *   limit?:      number (default 10)
 *
 * Returns the LearningSummary shape from aggregate.ts.
 */
import { z } from "zod";
import { aggregateLearningSignal } from "@/lib/learning/aggregate";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/billing";

export const dynamic = "force-dynamic";

const Query = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(request: Request) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const url = new URL(request.url);
    const params = Query.parse({
      windowDays: url.searchParams.get("windowDays") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const summary = await aggregateLearningSignal({ workspaceId, ...params });
    return Response.json(summary);
  } catch (err) {
    return errorResponse(err);
  }
}
