import { start } from "workflow/api";
import { outcomesRollupWorkflow } from "@/workflows/outcomes-rollup";
import { errorResponse } from "@/lib/http";

// Vercel Cron target. The cron schedule lives in vercel.json. Vercel attaches
// an "x-vercel-cron" header (and uses the project CRON_SECRET when set), so
// this route accepts unauthenticated GETs from Vercel's edge but verifies the
// optional CRON_SECRET when configured.

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
    const run = await start(outcomesRollupWorkflow, []);
    return Response.json({ runId: run.runId, status: "started" });
  } catch (err) {
    return errorResponse(err);
  }
}
