/**
 * POST /api/metrics
 * Record one or more metric values for a content item or campaign.
 * Used by the Distributor's metrics-cron and the Analyst sub-agent.
 *
 * GET /api/metrics?scopeType=content&scopeId=<uuid>&channel=<ch>
 * Return raw metric rows for a given scope.
 *
 * Phase 8.
 */

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CHANNELS, SCOPE_TYPES } from "@marketing/shared-types";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";
import { LEGACY_WORKSPACE_ID } from "@/lib/billing";

// Single metric entry
const MetricEntry = z.object({
  metric: z.string().min(1).max(100),
  value: z.number(),
  channel: z.enum(CHANNELS).optional(),
  observedAt: z.string().datetime().optional(),
});

const PostMetrics = z.object({
  workspaceId: z.string().uuid().optional(),
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: z.string().uuid(),
  metrics: z.array(MetricEntry).min(1).max(100),
});

export async function POST(request: Request) {
  try {
    if (!isInternal(request)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const input = await parseJson(request, PostMetrics);
    const db = getDb();

    // Resolve workspaceId from the scoped row when the caller doesn't supply
    // one — keeps internal cron callers (which only have a scope id) working.
    let workspaceId = input.workspaceId ?? null;
    if (!workspaceId) {
      if (input.scopeType === "content") {
        const [row] = await db
          .select({ workspaceId: schema.contentItems.workspaceId })
          .from(schema.contentItems)
          .where(eq(schema.contentItems.id, input.scopeId))
          .limit(1);
        workspaceId = row?.workspaceId ?? null;
      } else if (input.scopeType === "campaign") {
        const [row] = await db
          .select({ workspaceId: schema.campaigns.workspaceId })
          .from(schema.campaigns)
          .where(eq(schema.campaigns.id, input.scopeId))
          .limit(1);
        workspaceId = row?.workspaceId ?? null;
      }
    }
    const ws = workspaceId ?? LEGACY_WORKSPACE_ID;

    const rows = input.metrics.map((m) => ({
      workspaceId: ws,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      channel: m.channel ?? null,
      metric: m.metric,
      value: String(m.value),
      observedAt: m.observedAt ? new Date(m.observedAt) : new Date(),
    }));

    const inserted = await db
      .insert(schema.metrics)
      .values(rows)
      .returning();

    return Response.json({ inserted: inserted.length }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    if (!isInternal(request)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const scopeType = url.searchParams.get("scopeType");
    const scopeId = url.searchParams.get("scopeId");
    const channel = url.searchParams.get("channel");
    const limit = Math.min(500, parseInt(url.searchParams.get("limit") ?? "100", 10));

    if (!scopeType || !scopeId) {
      return Response.json({ error: "scopeType and scopeId are required" }, { status: 400 });
    }

    const db = getDb();
    const conditions = [
      eq(schema.metrics.scopeType, scopeType as (typeof SCOPE_TYPES)[number]),
      eq(schema.metrics.scopeId, scopeId),
    ];
    if (channel) {
      conditions.push(eq(schema.metrics.channel, channel as (typeof CHANNELS)[number]));
    }

    const rows = await db
      .select()
      .from(schema.metrics)
      .where(and(...conditions))
      .orderBy(desc(schema.metrics.observedAt))
      .limit(limit);

    return Response.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
