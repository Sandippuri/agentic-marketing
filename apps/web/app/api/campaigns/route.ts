import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CAMPAIGN_PHASES, CAMPAIGN_STATUSES } from "@marketing/shared-types";
import { getRequestActor } from "@/lib/auth";
import { internalWorkspaceOverride, isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";
import {
  LEGACY_WORKSPACE_ID,
  getWorkspaceContext,
  whereInWorkspace,
  type WorkspaceContext,
} from "@/lib/billing";

const CreateCampaign = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(200),
  phase: z.enum(CAMPAIGN_PHASES).optional(),
  briefMd: z.string().optional(),
});

/**
 * GET /api/campaigns
 * List campaigns. Optional query params: ?status= ?phase=
 *
 * Workspace scoping: authenticated callers see only their workspace's
 * campaigns. Internal-token callers see the Legacy workspace's campaigns
 * (cron/Manager/Distributor are still single-tenant pre-PR 5).
 */
export async function GET(request: Request) {
  try {
    const isInternalCall = isInternal(request);
    let ctx: WorkspaceContext | null = null;
    if (!isInternalCall) {
      ctx = await getWorkspaceContext();
    }

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const phaseParam = url.searchParams.get("phase");

    const db = getDb();
    const statusFilter =
      statusParam &&
      CAMPAIGN_STATUSES.includes(statusParam as (typeof CAMPAIGN_STATUSES)[number])
        ? eq(
            schema.campaigns.status,
            statusParam as (typeof CAMPAIGN_STATUSES)[number],
          )
        : undefined;
    const phaseFilter =
      phaseParam &&
      CAMPAIGN_PHASES.includes(phaseParam as (typeof CAMPAIGN_PHASES)[number])
        ? eq(
            schema.campaigns.phase,
            phaseParam as (typeof CAMPAIGN_PHASES)[number],
          )
        : undefined;

    // Internal callers send `x-workspace-id` for the workspace they meant;
    // when absent we keep the legacy fallback so old cron jobs keep working.
    const internalWs = isInternalCall ? internalWorkspaceOverride(request) : null;
    const filterCtx: WorkspaceContext | null = ctx
      ? ctx
      : isInternalCall
        ? ({ workspaceId: internalWs ?? LEGACY_WORKSPACE_ID } as WorkspaceContext)
        : null;
    const where = whereInWorkspace(
      schema.campaigns,
      filterCtx,
      statusFilter,
      phaseFilter,
    );

    const rows = await db
      .select()
      .from(schema.campaigns)
      .where(where)
      .orderBy(desc(schema.campaigns.createdAt));
    return Response.json(rows);
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
    const workspaceId = isInternalCall
      ? (internalWorkspaceOverride(request) ?? LEGACY_WORKSPACE_ID)
      : (await getWorkspaceContext()).workspaceId;

    const input = await parseJson(request, CreateCampaign);
    const db = getDb();

    // Idempotent on (workspace_id, slug). The Strategist's create_campaign
    // tool can be re-invoked when the sub-agent retries mid-run; a hard 23505
    // here used to wedge the chat. ON CONFLICT DO NOTHING returns no row
    // when the slug is taken — we then fetch and return the existing campaign.
    const [created] = await db
      .insert(schema.campaigns)
      .values({
        workspaceId,
        slug: input.slug,
        name: input.name,
        phase: input.phase ?? "buildup",
        briefMd: input.briefMd ?? null,
        ownerId: actor.id ?? null,
      })
      .onConflictDoNothing({
        target: [schema.campaigns.workspaceId, schema.campaigns.slug],
      })
      .returning();

    if (created) {
      await db.insert(schema.auditLog).values({
        actorId: actor.id ?? null,
        actorKind: actor.kind,
        action: "campaign.create",
        entityType: "campaigns",
        entityId: created.id,
        before: null,
        after: created as object,
      });
      return Response.json(created, { status: 201 });
    }

    const [existing] = await db
      .select()
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.workspaceId, workspaceId),
          eq(schema.campaigns.slug, input.slug),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error("campaign upsert: conflict reported but row not found");
    }
    return Response.json(existing, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
