import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const db = getDb();
    const [campaign] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, id))
      .limit(1);
    if (!campaign) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const items = await db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.campaignId, id));
    return Response.json({ ...campaign, contentItems: items });
  } catch (err) {
    return errorResponse(err);
  }
}

const PatchCampaign = z.object({
  name: z.string().min(1).max(200).optional(),
  phase: z.enum(["buildup", "launch", "post_launch"]).optional(),
  status: z.enum(["draft", "active", "paused", "completed", "archived"]).optional(),
  briefMd: z.string().optional(),
  calendarJson: z.unknown().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, PatchCampaign);
    const db = getDb();

    const updated = await withAudit(
      { db, actor, action: "campaign.update", entityType: "campaigns" },
      async () => {
        const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).limit(1);
        return row ?? null;
      },
      async () => {
        const [row] = await db
          .update(schema.campaigns)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(schema.campaigns.id, id))
          .returning();
        if (!row) throw new Error("not_found");
        return row;
      },
    );
    return Response.json(updated);
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return errorResponse(err);
  }
}
