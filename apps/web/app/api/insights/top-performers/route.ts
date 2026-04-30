/**
 * GET /api/insights/top-performers
 *
 * Returns the top-N content items by CTR (or engagement rate) per channel,
 * for a given time window.  Used by the /insights admin page and the Analyst
 * sub-agent.
 *
 * Query params:
 *   channel   – (optional) one of the Channel enum values
 *   window    – "7d" | "30d" | "90d" (default "30d")
 *   limit     – 1–50 (default 10)
 *   sortBy    – "ctr" | "engagement" | "impressions" | "clicks" (default "ctr")
 *
 * Phase 11 Day 4.
 */

import { desc, eq, and, sql } from "drizzle-orm";
import { getDb, schema, outcomes } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { CHANNELS } from "@marketing/shared-types";

const VALID_WINDOWS = ["7d", "30d", "90d"] as const;
const VALID_SORT = ["ctr", "engagement", "impressions", "clicks"] as const;

export async function GET(request: Request) {
  try {
    // Allow both admin UI (session cookie) and agent calls (internal token).
    if (!isInternal(request)) {
      await getRequestActor(); // throws if unauthenticated
    }

    const url = new URL(request.url);
    const channel = url.searchParams.get("channel") ?? undefined;
    const windowParam = (url.searchParams.get("window") ?? "30d") as
      | "7d"
      | "30d"
      | "90d";
    const limitParam = Math.min(
      50,
      Math.max(1, parseInt(url.searchParams.get("limit") ?? "10", 10)),
    );
    const sortBy = (url.searchParams.get("sortBy") ?? "ctr") as
      | "ctr"
      | "engagement"
      | "impressions"
      | "clicks";

    if (!VALID_WINDOWS.includes(windowParam)) {
      return Response.json({ error: "invalid window" }, { status: 400 });
    }
    if (channel && !CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
      return Response.json({ error: "invalid channel" }, { status: 400 });
    }
    if (!VALID_SORT.includes(sortBy)) {
      return Response.json({ error: "invalid sortBy" }, { status: 400 });
    }

    const db = getDb();

    const sortCol =
      sortBy === "ctr"
        ? outcomes.ctr
        : sortBy === "engagement"
          ? outcomes.engagementRate
          : sortBy === "impressions"
            ? outcomes.impressions
            : outcomes.clicks;

    const rows = await db
      .select({
        contentId: schema.contentItems.id,
        title: schema.contentItems.title,
        publishedUrl: schema.contentItems.publishedUrl,
        type: schema.contentItems.type,
        stage: schema.contentItems.stage,
        channel: outcomes.channel,
        window: outcomes.window,
        impressions: outcomes.impressions,
        clicks: outcomes.clicks,
        ctr: outcomes.ctr,
        engagementRate: outcomes.engagementRate,
        conversions: outcomes.conversions,
        computedAt: outcomes.computedAt,
      })
      .from(outcomes)
      .innerJoin(
        schema.contentItems,
        eq(outcomes.contentId, schema.contentItems.id),
      )
      .where(
        and(
          eq(outcomes.window, windowParam),
          channel
            ? eq(outcomes.channel, channel as (typeof CHANNELS)[number])
            : sql`true`,
        ),
      )
      .orderBy(desc(sortCol))
      .limit(limitParam);

    return Response.json(
      rows.map((r) => ({
        content_id: r.contentId,
        title: r.title,
        published_url: r.publishedUrl,
        type: r.type,
        stage: r.stage,
        channel: r.channel,
        window: r.window,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: parseFloat(r.ctr),
        engagement_rate: parseFloat(r.engagementRate),
        conversions: r.conversions,
        computed_at: r.computedAt,
      })),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
