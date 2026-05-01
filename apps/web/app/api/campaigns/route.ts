import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CAMPAIGN_PHASES, CAMPAIGN_STATUSES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const CreateCampaign = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(200),
  phase: z.enum(CAMPAIGN_PHASES).optional(),
  briefMd: z.string().optional(),
});

/**
 * GET /api/campaigns
 * List campaigns. Optional query params: ?status= ?phase=
 */
export async function GET(request: Request) {
  try {
    const isInternalCall = isInternal(request);
    if (!isInternalCall) {
      await getRequestActor();
    }

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const phaseParam = url.searchParams.get("phase");

    const db = getDb();
    const conditions = [];

    if (statusParam && CAMPAIGN_STATUSES.includes(statusParam as (typeof CAMPAIGN_STATUSES)[number])) {
      conditions.push(eq(schema.campaigns.status, statusParam as (typeof CAMPAIGN_STATUSES)[number]));
    }
    if (phaseParam && CAMPAIGN_PHASES.includes(phaseParam as (typeof CAMPAIGN_PHASES)[number])) {
      conditions.push(eq(schema.campaigns.phase, phaseParam as (typeof CAMPAIGN_PHASES)[number]));
    }

    const rows = await db
      .select()
      .from(schema.campaigns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.campaigns.createdAt));
    return Response.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, CreateCampaign);
    const db = getDb();
    const created = await withAudit(
      { db, actor, action: "campaign.create", entityType: "campaigns" },
      async () => null,
      async () => {
        const [row] = await db
          .insert(schema.campaigns)
          .values({
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
