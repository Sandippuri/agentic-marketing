import { getDb, schema } from "@marketing/db";
import {
  BRAND_MEMORY_SLUGS,
  BRAND_MEMORY_TITLES,
  type BrandMemorySlug,
} from "@marketing/shared-types";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export type BrandMemoryDoc = {
  slug: BrandMemorySlug;
  title: string;
  body: string;
  updatedBy: string | null;
  updatedAt: string | null;
};

// GET /api/brand-memory — return all five known brand-memory documents.
// Missing rows are returned with an empty body so the admin form has a
// stable shape regardless of whether the row has ever been saved.
export async function GET(request: Request) {
  try {
    const isInternalReq = isInternal(request);
    if (!isInternalReq) await getRequestActor();

    const db = getDb();
    const rows = await db.select().from(schema.brandMemory);
    const bySlug = new Map(rows.map((r) => [r.slug, r]));

    const docs: BrandMemoryDoc[] = BRAND_MEMORY_SLUGS.map((slug) => {
      const row = bySlug.get(slug);
      return {
        slug,
        title: row?.title ?? BRAND_MEMORY_TITLES[slug],
        body: row?.body ?? "",
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      };
    });

    return Response.json(docs);
  } catch (err) {
    return errorResponse(err);
  }
}
