import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CONTENT_TYPES, CONTENT_STAGES, CONTENT_STATUSES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const CreateContent = z.object({
  campaignId: z.string().uuid(),
  type: z.enum(CONTENT_TYPES),
  stage: z.enum(CONTENT_STAGES).optional(),
  title: z.string().min(1).max(300),
  bodyMd: z.string().default(""),
});

/**
 * GET /api/content
 * List content items. Filterable by campaignId, status, type.
 * Used by agents and the admin UI.
 */
export async function GET(request: Request) {
  try {
    const isInternalCall = isInternal(request);
    if (!isInternalCall) {
      await getRequestActor();
    }

    const url = new URL(request.url);
    const campaignId = url.searchParams.get("campaignId");
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

    const db = getDb();
    const conditions = [];

    if (campaignId) {
      conditions.push(eq(schema.contentItems.campaignId, campaignId));
    }
    if (status && CONTENT_STATUSES.includes(status as (typeof CONTENT_STATUSES)[number])) {
      conditions.push(eq(schema.contentItems.status, status as (typeof CONTENT_STATUSES)[number]));
    }
    if (type && CONTENT_TYPES.includes(type as (typeof CONTENT_TYPES)[number])) {
      conditions.push(eq(schema.contentItems.type, type as (typeof CONTENT_TYPES)[number]));
    }

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(schema.contentItems)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.contentItems.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.contentItems)
        .where(conditions.length > 0 ? and(...conditions) : undefined),
    ]);

    const total = countResult[0]?.total ?? 0;
    return Response.json({ items: rows, total, limit, offset });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, CreateContent);
    const db = getDb();
    const created = await withAudit(
      { db, actor, action: "content.create", entityType: "content_items" },
      async () => null,
      async () => {
        const [row] = await db
          .insert(schema.contentItems)
          .values({
            campaignId: input.campaignId,
            type: input.type,
            stage: input.stage ?? "explain",
            title: input.title,
            bodyMd: input.bodyMd,
          })
          .returning();
        return row!;
      },
    );
    return Response.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
