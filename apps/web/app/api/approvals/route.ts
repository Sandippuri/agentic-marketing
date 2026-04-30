import { eq, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

// GET /api/approvals?contentId=<uuid>
// Used by the Content sub-agent to read the latest changes_requested reason.
export async function GET(request: Request) {
  try {
    if (!isInternal(request)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const url = new URL(request.url);
    const contentId = url.searchParams.get("contentId");
    if (!contentId) {
      return Response.json({ error: "contentId required" }, { status: 400 });
    }
    const db = getDb();
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
