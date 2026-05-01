import { eq, desc, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/approvals
 *
 * Two modes:
 * 1. ?contentId=<uuid>   — list approvals for a specific content item (for Content sub-agent)
 * 2. ?pending=true       — list all undecided approvals with content title, oldest first
 */
export async function GET(request: Request) {
  try {
    if (!isInternal(request)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const contentId = url.searchParams.get("contentId");
    const pending = url.searchParams.get("pending") === "true";
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10));

    const db = getDb();

    if (pending) {
      // Return all undecided approvals joined with content item titles.
      const rows = await db
        .select({
          id: schema.approvals.id,
          contentId: schema.approvals.contentId,
          contentTitle: schema.contentItems.title,
          contentType: schema.contentItems.type,
          contentStage: schema.contentItems.stage,
          requestedAt: schema.approvals.requestedAt,
          ageMinutes: sql<number>`extract(epoch from (now() - ${schema.approvals.requestedAt})) / 60`,
        })
        .from(schema.approvals)
        .innerJoin(schema.contentItems, eq(schema.approvals.contentId, schema.contentItems.id))
        .where(isNull(schema.approvals.decision))
        .orderBy(schema.approvals.requestedAt)
        .limit(limit);
      return Response.json({ items: rows, total: rows.length });
    }

    if (!contentId) {
      return Response.json({ error: "contentId or pending=true required" }, { status: 400 });
    }

    const rows = await db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.contentId, contentId))
      .orderBy(desc(schema.approvals.requestedAt));
    return Response.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
