// GET /api/campaigns/[id]/calendar — returns the campaign's calendarJson
// items shaped as a flat list with indices. The Execute campaign form uses
// it to render the pre-flight checklist so the user picks which items run
// instead of auto-firing 14 single-post workflows at once.

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getWorkspaceContext } from "@/lib/billing";
import { internalWorkspaceOverride, isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";
import { LEGACY_WORKSPACE_ID } from "@/lib/billing";

export type CalendarItemPreview = {
  index: number;
  title: string;
  type: string | null;
  stage: string | null;
  phase: string | null;
  scheduledFor: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) {
      return Response.json({ error: "invalid_id" }, { status: 400 });
    }
    const isInternalCall = isInternal(request);
    const workspaceId = isInternalCall
      ? (internalWorkspaceOverride(request) ?? LEGACY_WORKSPACE_ID)
      : (await getWorkspaceContext()).workspaceId;

    const db = getDb();
    const [campaign] = await db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        calendarJson: schema.campaigns.calendarJson,
      })
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.id, id),
          eq(schema.campaigns.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!campaign) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const raw = Array.isArray(campaign.calendarJson)
      ? (campaign.calendarJson as unknown[])
      : [];
    const items: CalendarItemPreview[] = raw.map((it, index) => {
      const obj = (it ?? {}) as Record<string, unknown>;
      return {
        index,
        title: typeof obj.title === "string" ? obj.title : `Item ${index + 1}`,
        type: typeof obj.type === "string" ? obj.type : null,
        stage: typeof obj.stage === "string" ? obj.stage : null,
        phase: typeof obj.phase === "string" ? obj.phase : null,
        scheduledFor:
          typeof obj.scheduledFor === "string" ? obj.scheduledFor : null,
      };
    });
    return Response.json({
      campaignId: campaign.id,
      campaignName: campaign.name,
      items,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
