import { start } from "workflow/api";
import { learningSynthesisWorkflow } from "@/workflows/learning-synthesis";
import { errorResponse } from "@/lib/http";

// Vercel Cron target. Add a schedule entry to apps/web/vercel.json — e.g.
//   { "path": "/api/cron/learning-synthesis", "schedule": "0 4 * * 1" }
// runs weekly Mon 04:00 UTC. Token-gated via CRON_SECRET when set.

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
    const run = await start(learningSynthesisWorkflow, [{}]);
    return Response.json({ runId: run.runId, status: "started" });
  } catch (err) {
    return errorResponse(err);
  }
}
