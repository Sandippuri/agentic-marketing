import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { ASSET_STATUSES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";
import { getSignedAssetUrl } from "@/lib/supabase/storage";

// GET /api/assets/:id — return asset + a short-lived signed preview URL.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    if (!isInternal(request)) await getRequestActor();
    const { id } = await ctx.params;
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, id))
      .limit(1);
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });

    // Attach a signed URL so the approval card can display a preview directly.
    let signedUrl: string | null = null;
    try {
      signedUrl = await getSignedAssetUrl(row.storagePath);
    } catch {
      // If storage is not configured yet, return the row without a URL.
    }

    return Response.json({ ...row, signedUrl });
  } catch (err) {
    return errorResponse(err);
  }
}

const PatchAsset = z.object({
  status: z.enum(ASSET_STATUSES).optional(),
  storagePath: z.string().optional(),
});

// PATCH /api/assets/:id — update status or storage path.
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, PatchAsset);
    const db = getDb();

    const updated = await withAudit(
      { db, actor, action: "asset.update", entityType: "assets" },
      async () => {
        const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, id)).limit(1);
        return row ?? null;
      },
      async () => {
        const [row] = await db
          .update(schema.assets)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(schema.assets.id, id))
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
