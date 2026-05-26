import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CONTENT_TYPES, CONTENT_STAGES, CONTENT_STATUSES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { internalWorkspaceOverride, isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";
import {
  LEGACY_WORKSPACE_ID,
  getWorkspaceContext,
  whereInWorkspace,
  type WorkspaceContext,
} from "@/lib/billing";

const CreateContent = z.object({
  campaignId: z.string().uuid(),
  type: z.enum(CONTENT_TYPES),
  stage: z.enum(CONTENT_STAGES).optional(),
  title: z.string().min(1).max(300),
  bodyMd: z.string().default(""),
  // Migration 0040 reshaped image_brief from single object to array of
  // ImageBrief (1–4 entries). Free-form jsonb passthrough — schema lives in
  // packages/agents/src/sub-agents/content.ts (ImageBrief).
  imageBriefs: z.unknown().optional(),
});

/**
 * GET /api/content
 * List content items. Filterable by campaignId, status, type.
 * Used by agents and the admin UI.
 */
export async function GET(request: Request) {
  try {
    const isInternalCall = isInternal(request);
    const ctx: WorkspaceContext = isInternalCall
      ? ({
          workspaceId:
            internalWorkspaceOverride(request) ?? LEGACY_WORKSPACE_ID,
        } as WorkspaceContext)
      : await getWorkspaceContext();

    const url = new URL(request.url);
    const campaignId = url.searchParams.get("campaignId");
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

    const db = getDb();
    const campaignFilter = campaignId
      ? eq(schema.contentItems.campaignId, campaignId)
      : undefined;
    const statusFilter =
      status &&
      CONTENT_STATUSES.includes(status as (typeof CONTENT_STATUSES)[number])
        ? eq(
            schema.contentItems.status,
            status as (typeof CONTENT_STATUSES)[number],
          )
        : undefined;
    const typeFilter =
      type && CONTENT_TYPES.includes(type as (typeof CONTENT_TYPES)[number])
        ? eq(schema.contentItems.type, type as (typeof CONTENT_TYPES)[number])
        : undefined;
    const where = whereInWorkspace(
      schema.contentItems,
      ctx,
      campaignFilter,
      statusFilter,
      typeFilter,
    );

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(schema.contentItems)
        .where(where)
        .orderBy(desc(schema.contentItems.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.contentItems)
        .where(where),
    ]);

    const total = countResult[0]?.total ?? 0;
    return Response.json({ items: rows, total, limit, offset });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const isInternalCall = isInternal(request);
    const actor = isInternalCall
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const ctx: WorkspaceContext = isInternalCall
      ? ({
          workspaceId:
            internalWorkspaceOverride(request) ?? LEGACY_WORKSPACE_ID,
        } as WorkspaceContext)
      : await getWorkspaceContext();
    const input = await parseJson(request, CreateContent);
    const db = getDb();

    // Cross-tenant guard: refuse to create content_items rows that point at
    // a campaign in a different workspace. Avoids "agent forwards stale
    // campaignId" → silent data leak.
    const [parentCampaign] = await db
      .select({ workspaceId: schema.campaigns.workspaceId })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, input.campaignId))
      .limit(1);
    if (!parentCampaign || parentCampaign.workspaceId !== ctx.workspaceId) {
      return Response.json(
        { error: "campaign_not_in_workspace" },
        { status: 404 },
      );
    }

    const created = await withAudit(
      { db, actor, action: "content.create", entityType: "content_items" },
      async () => null,
      async () => {
        const [row] = await db
          .insert(schema.contentItems)
          .values({
            workspaceId: ctx.workspaceId,
            campaignId: input.campaignId,
            type: input.type,
            stage: input.stage ?? "explain",
            title: input.title,
            bodyMd: input.bodyMd,
            imageBriefs: input.imageBriefs ?? null,
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
