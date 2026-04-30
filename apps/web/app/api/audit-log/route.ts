import { z } from "zod";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { errorResponse } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";

const Query = z.object({
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  action: z.string().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: Request) {
  try {
    if (!isInternal(request)) await getRequestActor();
    const url = new URL(request.url);
    const params = Query.parse(Object.fromEntries(url.searchParams));
    const db = getDb();
    const filters: SQL[] = [];
    if (params.entityType) {
      filters.push(eq(schema.auditLog.entityType, params.entityType));
    }
    if (params.entityId) {
      filters.push(eq(schema.auditLog.entityId, params.entityId));
    }
    if (params.action) filters.push(eq(schema.auditLog.action, params.action));
    if (params.before) {
      filters.push(lt(schema.auditLog.at, new Date(params.before)));
    }
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(schema.auditLog.at))
      .limit(params.limit);
    return Response.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
