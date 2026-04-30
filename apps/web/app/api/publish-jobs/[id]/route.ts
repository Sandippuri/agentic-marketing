import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { PUBLISH_JOB_STATUSES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";

// externalUrl accepts either a full URL (linkedin/x/email) or a relative
// path starting with `/` (internal-blog routes back to /blog/<slug>).
const Patch = z.object({
  status: z.enum(PUBLISH_JOB_STATUSES).optional(),
  externalId: z.string().optional(),
  externalUrl: z
    .string()
    .refine((s) => s.startsWith("/") || /^https?:\/\//.test(s), {
      message: "must be an absolute URL or path starting with /",
    })
    .optional(),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
});

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.publishJobs)
    .where(eq(schema.publishJobs.id, id))
    .limit(1);
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(row);
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
    const input = await parseJson(request, Patch);
    const db = getDb();
    const updated = await withAudit(
      { db, actor, action: "publish_job.update", entityType: "publish_jobs" },
      async () => {
        const [row] = await db
          .select()
          .from(schema.publishJobs)
          .where(eq(schema.publishJobs.id, id))
          .limit(1);
        return row ?? null;
      },
      async () => {
        const [row] = await db
          .update(schema.publishJobs)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(schema.publishJobs.id, id))
          .returning();
        if (input.status === "succeeded" && row) {
          await db
            .update(schema.contentItems)
            .set({
              status: "published",
              publishedAt: new Date(),
              publishedUrl: input.externalUrl ?? null,
              updatedAt: new Date(),
            })
            .where(eq(schema.contentItems.id, row.contentId));
        }
        return row!;
      },
    );
    return Response.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
