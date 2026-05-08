import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The :id segment can be either a campaign UUID or its slug. Agents tend to
// remember the human-readable slug; the UI links by UUID. Resolve both here so
// downstream queries always run against the real UUID column.
async function resolveCampaign(idOrSlug: string) {
  const db = getDb();
  const column = UUID_RE.test(idOrSlug)
    ? schema.campaigns.id
    : schema.campaigns.slug;
  const [row] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(column, idOrSlug))
    .limit(1);
  return row ?? null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const campaign = await resolveCampaign(id);
    if (!campaign) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const db = getDb();
    const items = await db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.campaignId, campaign.id));
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
    const existing = await resolveCampaign(id);
    if (!existing) throw new Error("not_found");
    const db = getDb();

    const updated = await withAudit(
      { db, actor, action: "campaign.update", entityType: "campaigns" },
      async () => existing,
      async () => {
        const [row] = await db
          .update(schema.campaigns)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(schema.campaigns.id, existing.id))
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

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const existing = await resolveCampaign(id);
    if (!existing) throw new Error("not_found");
    const db = getDb();

    await withAudit(
      { db, actor, action: "campaign.delete", entityType: "campaigns" },
      async () => existing,
      async () => {
        await db
          .delete(schema.campaigns)
          .where(eq(schema.campaigns.id, existing.id));
        return null;
      },
    );
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return errorResponse(err);
  }
}
