import { start } from "workflow/api";
import { researchWorkflow } from "@/workflows/research";
import { errorResponse } from "@/lib/http";
import { LEGACY_WORKSPACE_ID } from "@/lib/billing";

// Vercel Cron target — runs daily at 02:00 UTC (07:45 Asia/Kathmandu).
// Schedule lives in apps/web/vercel.json: `0 2 * * *`.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${secret}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }
    // Daily research cron is currently single-tenant: runs against the
    // Legacy workspace's keyword config. PR 5 will fan out per workspace.
    const run = await start(researchWorkflow, [
      { workspaceId: LEGACY_WORKSPACE_ID },
    ]);
    return Response.json({ runId: run.runId, status: "started" });
  } catch (err) {
    return errorResponse(err);
  }
}
