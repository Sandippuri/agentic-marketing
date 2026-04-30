/**
 * POST /api/content/similar
 *
 * Accepts a pre-computed embedding vector (produced by the Manager) and returns
 * the top-N approved content items closest to that vector using pgvector cosine
 * similarity.  Optionally filters by channel, minimum CTR, and minimum
 * engagement rate.
 *
 * Phase 11 Day 3.
 */

import { z } from "zod";
import { sql, eq, and, gte } from "drizzle-orm";
import { getDb, schema, contentEmbeddings, outcomes } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";
import { CHANNELS } from "@marketing/shared-types";

const SimilarRequest = z.object({
  /** Pre-embedded query vector (text-embedding-3-small, 1536 dims). */
  vector: z.array(z.number()).length(1536),
  channel: z.enum(CHANNELS).optional(),
  minCTR: z.number().min(0).max(1).optional(),
  minEngagement: z.number().min(0).max(1).optional(),
  window: z.enum(["7d", "30d", "90d"]).optional().default("30d"),
  limit: z.number().int().min(1).max(20).optional().default(5),
});

export async function POST(request: Request) {
  try {
    if (!isInternal(request)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const input = await parseJson(request, SimilarRequest);
    const db = getDb();

    // Build the pgvector literal: '[0.1,0.2,...]'::vector
    const vectorLiteral = `[${input.vector.join(",")}]`;

    /**
     * Strategy:
     * 1. Inner query: get content_embeddings ordered by cosine distance.
     * 2. Join to content_items (must be approved + have a published_url or bodyMd).
     * 3. Left-join to outcomes for the requested window.
     * 4. Apply channel / CTR / engagement filters.
     * 5. Return top N with their outcomes.
     */
    const rows = await db
      .select({
        contentId: schema.contentItems.id,
        title: schema.contentItems.title,
        bodyMd: schema.contentItems.bodyMd,
        publishedUrl: schema.contentItems.publishedUrl,
        channel: outcomes.channel,
        ctr: outcomes.ctr,
        engagementRate: outcomes.engagementRate,
        impressions: outcomes.impressions,
        clicks: outcomes.clicks,
        distance: sql<number>`(${contentEmbeddings.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)})`,
      })
      .from(contentEmbeddings)
      .innerJoin(
        schema.contentItems,
        and(
          eq(contentEmbeddings.contentId, schema.contentItems.id),
          eq(schema.contentItems.status, "approved"),
        ),
      )
      .leftJoin(
        outcomes,
        and(
          eq(outcomes.contentId, schema.contentItems.id),
          sql`${outcomes.window} = ${input.window}`,
          input.channel ? eq(outcomes.channel, input.channel) : sql`true`,
        ),
      )
      .where(
        and(
          input.minCTR !== undefined
            ? gte(outcomes.ctr, String(input.minCTR))
            : sql`true`,
          input.minEngagement !== undefined
            ? gte(outcomes.engagementRate, String(input.minEngagement))
            : sql`true`,
          input.channel ? eq(outcomes.channel, input.channel) : sql`true`,
        ),
      )
      .orderBy(
        sql`(${contentEmbeddings.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)})`,
      )
      .limit(input.limit ?? 5);

    return Response.json(
      rows.map((r) => ({
        content_id: r.contentId,
        title: r.title,
        body_md: r.bodyMd,
        published_url: r.publishedUrl,
        outcomes: r.ctr
          ? {
              channel: r.channel,
              ctr: parseFloat(r.ctr),
              engagement_rate: parseFloat(r.engagementRate ?? "0"),
              impressions: r.impressions,
              clicks: r.clicks,
            }
          : null,
        similarity: r.distance != null ? 1 - r.distance : null,
      })),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
