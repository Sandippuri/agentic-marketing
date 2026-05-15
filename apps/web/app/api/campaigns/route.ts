import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CAMPAIGN_PHASES, CAMPAIGN_STATUSES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
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
    // Internal callers fall back to Legacy via a fabricated filter.
    const filterCtx: WorkspaceContext | null = ctx ?? null;
    const legacyOnly = !ctx;

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

    const where = legacyOnly
      ? // internal callers: filter explicitly to Legacy workspace.
        whereInWorkspace(
          schema.campaigns,
          { workspaceId: LEGACY_WORKSPACE_ID } as WorkspaceContext,
          statusFilter,
          phaseFilter,
        )
      : whereInWorkspace(schema.campaigns, filterCtx, statusFilter, phaseFilter);

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
      ? LEGACY_WORKSPACE_ID
      : (await getWorkspaceContext()).workspaceId;

    const input = await parseJson(request, CreateCampaign);
    const db = getDb();
    const created = await withAudit(
      { db, actor, action: "campaign.create", entityType: "campaigns" },
      async () => null,
      async () => {
        const [row] = await db
          .insert(schema.campaigns)
          .values({
            workspaceId,
            slug: input.slug,
            name: input.name,
            phase: input.phase ?? "buildup",
            briefMd: input.briefMd ?? null,
            ownerId: actor.id ?? null,
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
