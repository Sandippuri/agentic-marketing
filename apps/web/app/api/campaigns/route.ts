import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CAMPAIGN_PHASES } from "@marketing/shared-types";
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

export async function GET() {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.campaigns)
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
