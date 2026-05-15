import { z } from "zod";
import { start } from "workflow/api";
import { researchWorkflow } from "@/workflows/research";
import { errorResponse, parseJson } from "@/lib/http";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { LEGACY_WORKSPACE_ID, getWorkspaceContext } from "@/lib/billing";
import { RESEARCH_SEARCH_PROVIDERS } from "@marketing/shared-types";

// On-demand trigger for the daily research workflow. Same workflow the cron
// runs, but invoked manually from the /research admin page. Accepts optional
// overrides for one-off / per-campaign runs:
//   - keywords[]   ad-hoc keyword list (skips the global settings row)
//   - provider     override the configured search provider for this run
//   - campaignId   pin all kb_write_finding calls to a campaign scope
// All three are optional; with no body the run mirrors the cron exactly.

export const dynamic = "force-dynamic";

const RunBody = z.object({
  keywords: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  provider: z.enum(RESEARCH_SEARCH_PROVIDERS).optional(),
  campaignId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    const isInternalCall = isInternal(request);
    if (!isInternalCall) await getRequestActor();
    const workspaceId = isInternalCall
      ? LEGACY_WORKSPACE_ID
      : (await getWorkspaceContext()).workspaceId;
    const body = await parseJson(request, RunBody);
    const run = await start(researchWorkflow, [{ ...body, workspaceId }]);
    return Response.json({ runId: run.runId, status: "started" });
  } catch (err) {
    return errorResponse(err);
  }
}
