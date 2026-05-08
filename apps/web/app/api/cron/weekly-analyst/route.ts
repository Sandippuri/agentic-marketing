import { start } from "workflow/api";
import { weeklyAnalystWorkflow } from "@/workflows/weekly-analyst";
import { errorResponse } from "@/lib/http";

// Vercel Cron target — runs weekly. Phase 3 of the migration: replaces
// apps/manager/src/cron.ts (which used setTimeout). The schedule lives in
// apps/web/vercel.json: 15 3 * * 1 (Mon 03:15 UTC = 09:00 Kathmandu).

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
    const run = await start(weeklyAnalystWorkflow, []);
    return Response.json({ runId: run.runId, status: "started" });
  } catch (err) {
    return errorResponse(err);
  }
}
