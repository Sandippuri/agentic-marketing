import { after } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { assertContentTransition } from "@/lib/state-machine";
import { errorResponse } from "@/lib/http";
import { generateAssetVariants } from "@/lib/asset-variants";

// Submit a content_item for review. Creates an open `approvals` row.
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
      { db, actor, action: "content.submit", entityType: "content_items" },
      async () => {
        const [row] = await db
          .select()
          .from(schema.contentItems)
          .where(eq(schema.contentItems.id, id))
          .limit(1);
        return row ?? null;
      },
      async () => {
        const [before] = await db
          .select()
          .from(schema.contentItems)
          .where(eq(schema.contentItems.id, id))
          .limit(1);
        if (!before) throw new Error("not_found");
        assertContentTransition(before.status, "in_review");
        const [updated] = await db
          .update(schema.contentItems)
          .set({ status: "in_review", updatedAt: new Date() })
          .where(eq(schema.contentItems.id, id))
          .returning();
        await db
          .insert(schema.approvals)
          .values({ contentId: id });
        return updated!;
      },
    );

    // Generate image variants in the background unless the post opted out.
    // The reviewer can flip the toggle on /approvals and the PATCH route will
    // re-trigger generation. On Vercel, after() defers to waitUntil so the
    // work survives the response returning.
    if (result.needsImages !== false) {
      after(async () => {
        try {
          await generateAssetVariants({ contentId: id });
        } catch (err) {
          console.warn(
            `[content.submit] background asset generation failed for ${id}`,
            err,
          );
        }
      });
    }

    return Response.json(result);
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return errorResponse(err);
  }
}
