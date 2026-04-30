import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { assertContentTransition } from "@/lib/state-machine";
import { errorResponse, parseJson } from "@/lib/http";

const PatchContent = z.object({
  title: z.string().min(1).max(300).optional(),
  bodyMd: z.string().optional(),
  changeNote: z.string().optional(),
});

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    if (!isInternal(request)) await getRequestActor();
    const db = getDb();
    const row = await loadContent(db, id);
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, PatchContent);
    const db = getDb();

    const updated = await withAudit(
      { db, actor, action: "content.update", entityType: "content_items" },
      async () => loadContent(db, id),
      async () => {
        const before = await loadContent(db, id);
        if (!before) throw new ContentNotFound();
        // PATCH on draft / in_review only — no in-place edits to approved content.
        if (before.status !== "draft" && before.status !== "in_review") {
          assertContentTransition(before.status, "draft");
        }
        const [row] = await db
          .update(schema.contentItems)
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.contentItems.id, id))
          .returning();
        if (input.bodyMd !== undefined) {
          await db.insert(schema.contentRevisions).values({
            contentId: id,
            bodyMd: input.bodyMd,
            changeNote: input.changeNote ?? null,
            authorId: actor.id ?? null,
            authorKind: actor.kind,
          });
        }
        return row!;
      },
    );
    return Response.json(updated);
  } catch (err) {
    if (err instanceof ContentNotFound) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return errorResponse(err);
  }
}

class ContentNotFound extends Error {}

async function loadContent(
  db: ReturnType<typeof getDb>,
  id: string,
): Promise<schema.ContentItem | null> {
  const [row] = await db
    .select()
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, id))
    .limit(1);
  return row ?? null;
}
