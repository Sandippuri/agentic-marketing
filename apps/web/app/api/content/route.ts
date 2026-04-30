import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import { CONTENT_TYPES, CONTENT_STAGES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const CreateContent = z.object({
  campaignId: z.string().uuid(),
  type: z.enum(CONTENT_TYPES),
  stage: z.enum(CONTENT_STAGES).optional(),
  title: z.string().min(1).max(300),
  bodyMd: z.string().default(""),
});

export async function POST(request: Request) {
  try {
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, CreateContent);
    const db = getDb();
    const created = await withAudit(
      { db, actor, action: "content.create", entityType: "content_items" },
      async () => null,
      async () => {
        const [row] = await db
          .insert(schema.contentItems)
          .values({
            campaignId: input.campaignId,
            type: input.type,
            stage: input.stage ?? "explain",
            title: input.title,
            bodyMd: input.bodyMd,
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
