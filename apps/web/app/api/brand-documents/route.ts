import { z } from "zod";
import { desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { BRAND_DOC_MIME_TYPES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";
import { brandDocStoragePath, uploadBrandDoc } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

// 25 MB cap. Anything larger is almost certainly a scanned PDF that the
// extractor won't handle well anyway.
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 10;

const Filename = z.string().min(1).max(255);
const MimeType = z.enum(BRAND_DOC_MIME_TYPES);

// POST /api/brand-documents — upload one or more brand-corpus files.
// Accepts multipart/form-data with one or more `file` parts. Creates a
// brand_documents row per file, uploads bytes to Supabase storage, and
// returns the inserted rows.
export async function POST(request: Request) {
  try {
    const actor = await getRequestActor();
    const db = getDb();

    const form = await request.formData();
    const files = form
      .getAll("file")
      .filter((v): v is File => v instanceof File);

    if (files.length === 0) {
      return Response.json({ error: "no_files" }, { status: 400 });
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return Response.json(
        { error: "too_many_files", limit: MAX_FILES_PER_REQUEST },
        { status: 400 },
      );
    }

    const rows: (typeof schema.brandDocuments.$inferSelect)[] = [];
    for (const file of files) {
      if (file.size === 0) {
        return Response.json(
          { error: "empty_file", filename: file.name },
          { status: 400 },
        );
      }
      if (file.size > MAX_BYTES) {
        return Response.json(
          { error: "file_too_large", filename: file.name, limit: MAX_BYTES },
          { status: 400 },
        );
      }

      const filename = Filename.parse(file.name);
      const mimeType = MimeType.parse(file.type || "application/octet-stream");

      // Insert row first to get the id, then upload bytes under that id so
      // orphaned uploads can be reconciled against brand_documents rows.
      const inserted = await withAudit(
        {
          db,
          actor,
          action: "brand_document.create",
          entityType: "brand_documents",
        },
        async () => null,
        async () => {
          const [row] = await db
            .insert(schema.brandDocuments)
            .values({
              filename,
              mimeType,
              sizeBytes: file.size,
              storagePath: "pending",
              uploadedBy: actor.id ?? null,
              status: "uploaded",
            })
            .returning();
          if (!row) throw new Error("brand_documents insert returned no row");
          return row;
        },
      );

      const storagePath = brandDocStoragePath(inserted.id, filename);
      const buffer = Buffer.from(await file.arrayBuffer());
      await uploadBrandDoc(storagePath, buffer, mimeType);

      const [updated] = await db
        .update(schema.brandDocuments)
        .set({ storagePath, updatedAt: new Date() })
        .where(eq(schema.brandDocuments.id, inserted.id))
        .returning();
      rows.push(updated ?? inserted);
    }

    return Response.json(rows, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/brand-documents — list all non-removed documents (newest first).
// Internal callers (extractor workflow) get the same list.
export async function GET(request: Request) {
  try {
    if (!isInternal(request)) await getRequestActor();
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.brandDocuments)
      .where(isNull(schema.brandDocuments.removedAt))
      .orderBy(desc(schema.brandDocuments.uploadedAt));
    return Response.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
