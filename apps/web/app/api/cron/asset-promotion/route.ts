import { runPromotionPass } from "@/lib/asset-learning";
import { errorResponse } from "@/lib/http";

// Vercel Cron target. Promotes high-scoring + high-performing assets into the
// per-campaign `approved-assets` KB collection so the Art Director references
// them on future runs. Schedule lives in vercel.json.
//
// Auth: optional CRON_SECRET, same pattern as the other cron routes.

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
    // Look at the last 14 days — fresh enough that outcomes are settled, old
    // enough to give the 7d window time to fill. Defaults match the module's
    // conservative judge/engagement floors.
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const result = await runPromotionPass({ since });
    return Response.json({ status: "ok", ...result });
  } catch (err) {
    return errorResponse(err);
  }
}
