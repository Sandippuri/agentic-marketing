import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { deleteBrandDoc } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

const IdParam = z.string().uuid();

// DELETE /api/brand-documents/[id] — soft-delete the doc + purge its
// embeddings. The row stays for audit; future extraction runs ignore it
// (we filter on `removed_at IS NULL`).
export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await getRequestActor();
    const { id } = await ctx.params;
    const docId = IdParam.parse(id);
    const db = getDb();

    const after = await withAudit(
      {
        db,
        actor,
        action: "brand_document.remove",
        entityType: "brand_documents",
      },
      async () => {
        const [row] = await db
          .select()
          .from(schema.brandDocuments)
          .where(
            and(
              eq(schema.brandDocuments.id, docId),
              isNull(schema.brandDocuments.removedAt),
            ),
          )
          .limit(1);
        return row ?? null;
      },
      async () => {
        const [row] = await db
          .update(schema.brandDocuments)
          .set({
            status: "removed",
            removedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.brandDocuments.id, docId),
              isNull(schema.brandDocuments.removedAt),
            ),
          )
          .returning();
        if (!row) throw new Error("brand_document not found or already removed");

        // Purge embeddings tied to this doc. The extractor keys source_id off
        // the doc UUID, so a single equality filter on source_id is enough.
        await db
          .delete(schema.embeddings)
          .where(
            and(
              eq(schema.embeddings.sourceType, "brand_doc"),
              eq(schema.embeddings.sourceId, row.id),
            ),
          );

        // Best-effort storage delete; the soft-delete is the source of truth.
        try {
          await deleteBrandDoc(row.storagePath);
        } catch (e) {
          console.warn(
            "[brand-document.remove] storage delete failed",
            (e as Error).message,
          );
        }

        return row;
      },
    );

    return Response.json(after);
  } catch (err) {
    return errorResponse(err);
  }
}
