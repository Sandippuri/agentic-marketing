import { z } from "zod";
import { APPROVAL_DECISIONS } from "@marketing/shared-types";
import { approvalHook } from "@/workflows/single-post";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const Body = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(APPROVAL_DECISIONS),
  reason: z.string().max(2000).nullish(),
});

// POST /api/workflows/approve
// Resumes the single-post workflow waiting on token `approval:<approvalId>`.
// Phase 1 exposes this for testing; in normal use the existing
// /api/approvals/[id] route forwards to it after writing the DB decision.
export async function POST(request: Request) {
  try {
    if (!isInternal(request)) {
      await getRequestActor();
    }
    const input = await parseJson(request, Body);

    try {
      await approvalHook.resume(`approval:${input.approvalId}`, {
        decision: input.decision,
        reason: input.reason ?? null,
      });
      return Response.json({ resumed: true });
    } catch {
      // No workflow waiting on this token — that's fine for non-workflow
      // approvals. Surface it as a soft signal so the caller can ignore it.
      return Response.json({ resumed: false });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
