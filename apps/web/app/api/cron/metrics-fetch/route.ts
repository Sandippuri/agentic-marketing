import { start } from "workflow/api";
import { metricsCronFanOutWorkflow } from "@/workflows/metrics";
import { errorResponse } from "@/lib/http";

// Vercel Cron target — fans out a metrics-fetch workflow per due publish_job.
// See vercel.json for the schedule.

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
    const run = await start(metricsCronFanOutWorkflow, []);
    return Response.json({ runId: run.runId, status: "started" });
  } catch (err) {
    return errorResponse(err);
  }
}
