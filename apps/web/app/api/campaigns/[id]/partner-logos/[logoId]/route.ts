// DELETE /api/campaigns/[id]/partner-logos/[logoId] — remove a partner logo.
//
// Read-modify-write on campaigns.visualIdentity.partner_logos. Storage object
// is best-effort deleted; the metadata removal is the source of truth.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { getWorkspaceContext } from "@/lib/billing/workspace-context";
import { errorResponse } from "@/lib/http";
import { deleteAsset } from "@/lib/supabase/storage";
import type {
  PartnerLogo,
  VisualIdentity,
} from "@marketing/agents/sub-agents/strategist";

export const dynamic = "force-dynamic";

const IdParam = z.string().uuid();

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string; logoId: string }> },
) {
  try {
    const actor = await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const { id, logoId } = await ctx.params;
    const campaignId = IdParam.parse(id);
    const targetLogoId = IdParam.parse(logoId);

    const db = getDb();
    const [existing] = await db
      .select()
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.id, campaignId),
          eq(schema.campaigns.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const vi = (existing.visualIdentity ?? null) as VisualIdentity | null;
    const current = Array.isArray(vi?.partner_logos) ? vi.partner_logos : [];
    const removed = current.find((l) => l.id === targetLogoId);
    if (!removed) {
      return Response.json({ error: "logo_not_found" }, { status: 404 });
    }
    const remaining: PartnerLogo[] = current.filter((l) => l.id !== targetLogoId);

    const next: VisualIdentity = {
      recurring_motifs: vi?.recurring_motifs ?? [],
      color_mood: vi?.color_mood ?? "",
      art_style: vi?.art_style ?? "",
      banned_aesthetics: vi?.banned_aesthetics ?? [],
      partner_logos: remaining,
    };

    await withAudit(
      {
        db,
        actor,
        action: "campaign.partner_logo.remove",
        entityType: "campaigns",
      },
      async () => existing,
      async () => {
        const [row] = await db
          .update(schema.campaigns)
          .set({ visualIdentity: next, updatedAt: new Date() })
          .where(eq(schema.campaigns.id, campaignId))
          .returning();
        if (!row) throw new Error("not_found");
        return row;
      },
    );

    // Storage cleanup is best-effort — the metadata removal is what gates
    // visibility in the pipeline. A leftover object is harmless.
    try {
      await deleteAsset(removed.storagePath);
    } catch (err) {
      console.warn(
        "[partner_logo.remove] storage delete failed",
        (err as Error).message,
      );
    }

    return Response.json({ ok: true, removedId: targetLogoId });
  } catch (err) {
    return errorResponse(err);
  }
}
