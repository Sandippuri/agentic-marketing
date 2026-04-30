import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { ASSET_KINDS } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";
import { getSignedAssetUrl } from "@/lib/supabase/storage";

const CreateAsset = z.object({
  contentId: z.string().uuid().optional(),
  kind: z.enum(ASSET_KINDS),
  storagePath: z.string().min(1),
  templateId: z.string().optional(),
  promptUsed: z.string().optional(),
});

// POST /api/assets — create a new asset record.
export async function POST(request: Request) {
  try {
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, CreateAsset);
    const db = getDb();

    const created = await withAudit(
      { db, actor, action: "asset.create", entityType: "assets" },
      async () => null,
      async () => {
        const [row] = await db
          .insert(schema.assets)
          .values({
            contentId: input.contentId ?? null,
            kind: input.kind,
            storagePath: input.storagePath,
            templateId: input.templateId ?? null,
            promptUsed: input.promptUsed ?? null,
            status: "draft",
          })
          .returning();
        return row!;
      },
    );

    return Response.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/assets?contentId=<uuid> — list assets for a content item.
export async function GET(request: Request) {
  try {
    if (!isInternal(request)) await getRequestActor();
    const url = new URL(request.url);
    const contentId = url.searchParams.get("contentId");
    const db = getDb();

    const rows = contentId
      ? await db
          .select()
          .from(schema.assets)
          .where(eq(schema.assets.contentId, contentId))
      : await db.select().from(schema.assets).limit(50);

    return Response.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
