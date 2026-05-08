import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";

// POST /api/assets/:id/select — mark this asset as the chosen variant.
// Downgrades any sibling assets (same contentId) currently in "approved" back
// to "draft" so only one variant is ever in the approved state.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const db = getDb();

    const result = await withAudit(
      { db, actor, action: "asset.select", entityType: "assets" },
      async () => {
        const [row] = await db
          .select()
          .from(schema.assets)
          .where(eq(schema.assets.id, id))
          .limit(1);
        return row ?? null;
      },
      async () => {
        const [target] = await db
          .select({ contentId: schema.assets.contentId })
          .from(schema.assets)
          .where(eq(schema.assets.id, id))
          .limit(1);
        if (!target) throw new Error("not_found");

        if (target.contentId) {
          await db
            .update(schema.assets)
            .set({ status: "draft", updatedAt: new Date() })
            .where(
              and(
                eq(schema.assets.contentId, target.contentId),
                eq(schema.assets.status, "approved"),
                ne(schema.assets.id, id),
              ),
            );
        }

        const [updated] = await db
          .update(schema.assets)
          .set({ status: "approved", updatedAt: new Date() })
          .where(eq(schema.assets.id, id))
          .returning();
        return updated!;
      },
    );

    return Response.json(result);
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return errorResponse(err);
  }
}
