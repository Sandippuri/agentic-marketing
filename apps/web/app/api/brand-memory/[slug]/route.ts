import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import {
  BRAND_MEMORY_SLUGS,
  BRAND_MEMORY_TITLES,
  type BrandMemorySlug,
} from "@marketing/shared-types";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { withAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const SlugParam = z.enum(BRAND_MEMORY_SLUGS);

const PutBody = z.object({
  body: z.string().max(50_000),
  title: z.string().min(1).max(200).optional(),
});

export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const parsed = SlugParam.parse(slug);

    const isInternalReq = isInternal(request);
    if (!isInternalReq) await getRequestActor();

    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.brandMemory)
      .where(
        and(
          eq(schema.brandMemory.slug, parsed),
          isNull(schema.brandMemory.campaignId),
        ),
      )
      .limit(1);

    return Response.json({
      slug: parsed,
      title: row?.title ?? BRAND_MEMORY_TITLES[parsed],
      body: row?.body ?? "",
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/brand-memory/[slug] — upsert a single brand document.
// Human-only: the manager reads but never writes brand memory.
export async function PUT(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const parsed: BrandMemorySlug = SlugParam.parse(slug);

    const actor = await getRequestActor();
    const input = await parseJson(request, PutBody);
    const db = getDb();
    const title = input.title ?? BRAND_MEMORY_TITLES[parsed];

    const after = await withAudit(
      { db, actor, action: "brand_memory.update", entityType: "brand_memory" },
      async () => {
        const [row] = await db
          .select()
          .from(schema.brandMemory)
          .where(
            and(
              eq(schema.brandMemory.slug, parsed),
              isNull(schema.brandMemory.campaignId),
            ),
          )
          .limit(1);
        return row ?? null;
      },
      async () => {
        const [row] = await db
          .insert(schema.brandMemory)
          .values({
            slug: parsed,
            title,
            body: input.body,
            updatedBy: actor.id ?? null,
          })
          .onConflictDoUpdate({
            target: schema.brandMemory.slug,
            targetWhere: sql`"campaign_id" IS NULL`,
            set: {
              title,
              body: input.body,
              updatedBy: actor.id ?? null,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!row) throw new Error("brand_memory upsert returned no row");
        return row;
      },
    );

    return Response.json({
      slug: parsed,
      title: after.title,
      body: after.body,
      updatedBy: after.updatedBy,
      updatedAt: after.updatedAt.toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
