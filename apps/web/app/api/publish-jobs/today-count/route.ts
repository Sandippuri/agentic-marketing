import { eq, and, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";
import type { Channel } from "@marketing/shared-types";

export const dynamic = "force-dynamic";

// Returns today's succeeded publish_job counts per channel.
// Internal-only — used by the Distributor for channel-cap enforcement.
export async function GET(request: Request) {
  try {
    if (!isInternal(request)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const db = getDb();
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);

    const rows = await db
      .select({
        channel: schema.publishJobs.channel,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.publishJobs)
      .where(
        and(
          eq(schema.publishJobs.status, "succeeded"),
          gte(schema.publishJobs.createdAt, todayUtc),
        ),
      )
      .groupBy(schema.publishJobs.channel);

    const counts: Partial<Record<Channel, number>> = {};
    for (const row of rows) counts[row.channel] = row.count;
    return Response.json(counts);
  } catch (err) {
    return errorResponse(err);
  }
}
