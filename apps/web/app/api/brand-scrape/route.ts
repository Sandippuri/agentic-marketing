// POST /api/brand-scrape — given a website URL, fetch and parse the landing
// page, render it as a markdown brand-document, and persist it the same way
// /api/brand-documents would. Returns the row(s) using the same shape so the
// onboarding wizard can drop the result straight into its docs list and
// kick off /api/brand-extract.
//
// This is the "I don't have a brand book, just look at our site" path.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { brandDocStoragePath, uploadBrandDoc } from "@/lib/supabase/storage";
import { getWorkspaceContext } from "@/lib/billing";
import { scrapeLandingPage, ScrapeError } from "@/lib/scraper/landing-page";

export const dynamic = "force-dynamic";
// Network fetch + a few stylesheet fetches.
export const maxDuration = 60;

const BodySchema = z.object({
  url: z.string().min(1).max(2_000),
});

export async function POST(request: Request) {
  try {
    const actor = await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const db = getDb();

    const { url } = BodySchema.parse(await request.json());

    let scrape;
    try {
      scrape = await scrapeLandingPage(url);
    } catch (err) {
      if (err instanceof ScrapeError) {
        return Response.json(
          { error: err.kind, message: err.message },
          { status: err.kind === "invalid_url" ? 400 : 422 },
        );
      }
      throw err;
    }

    const filename = `landing-page-${safeHost(scrape.host)}.md`;
    const buffer = Buffer.from(scrape.markdown, "utf8");
    const mimeType = "text/markdown" as const;

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
            workspaceId,
            filename,
            mimeType,
            sizeBytes: buffer.byteLength,
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
    await uploadBrandDoc(storagePath, buffer, mimeType);

    const [updated] = await db
      .update(schema.brandDocuments)
      .set({ storagePath, updatedAt: new Date() })
      .where(eq(schema.brandDocuments.id, inserted.id))
      .returning();

    return Response.json(
      {
        document: updated ?? inserted,
        scrape: {
          finalUrl: scrape.finalUrl,
          host: scrape.host,
          title: scrape.title,
          description: scrape.description,
          logoUrl: scrape.logoUrl,
          colors: scrape.colors,
          fontFamilies: scrape.fontFamilies,
          headingCount: scrape.headings.length,
          bodyChars: scrape.bodyText.length,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

function safeHost(host: string): string {
  return host.replace(/[^a-z0-9.-]/gi, "_").slice(0, 80);
}
