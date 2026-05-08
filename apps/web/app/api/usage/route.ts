/**
 * GET /api/usage
 *
 * Aggregates the llm_usage table into the totals/breakdowns rendered on the
 * settings page. Returns three windows (today / 7d / 30d / all), plus model,
 * agent, and recent-call breakdowns.
 *
 * Auth: admin session cookie or internal token (matches /api/settings).
 */

import { sql, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Bucket = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
};

type ApiResponse = {
  totals: { today: Bucket; "7d": Bucket; "30d": Bucket; all: Bucket };
  byModel: Array<{ model: string; provider: string } & Bucket>;
  byAgent: Array<{ agent: string } & Bucket>;
  recent: Array<{
    id: string;
    occurredAt: string;
    agent: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number | null;
  }>;
};

function emptyBucket(): Bucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
  };
}

export async function GET(request: Request) {
  try {
    if (!isInternal(request)) await getRequestActor();
    const db = getDb();
    const t = schema.llmUsage;

    const aggCols = {
      inputTokens: sql<number>`coalesce(sum(${t.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${t.outputTokens}), 0)::int`,
      cachedInputTokens: sql<number>`coalesce(sum(${t.cachedInputTokens}), 0)::int`,
      totalTokens: sql<number>`coalesce(sum(${t.totalTokens}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${t.costUsd}), 0)::float8`,
      calls: sql<number>`count(*)::int`,
    };

    // Single query that buckets each row into all four windows in one pass.
    // Postgres date_trunc('day', now()) gives midnight in server TZ which is
    // close enough for a top-line "today" number.
    const totalsRow = await db
      .select({
        todayInput: sql<number>`coalesce(sum(case when ${t.occurredAt} >= date_trunc('day', now()) then ${t.inputTokens} else 0 end), 0)::int`,
        todayOutput: sql<number>`coalesce(sum(case when ${t.occurredAt} >= date_trunc('day', now()) then ${t.outputTokens} else 0 end), 0)::int`,
        todayCached: sql<number>`coalesce(sum(case when ${t.occurredAt} >= date_trunc('day', now()) then ${t.cachedInputTokens} else 0 end), 0)::int`,
        todayTotal: sql<number>`coalesce(sum(case when ${t.occurredAt} >= date_trunc('day', now()) then ${t.totalTokens} else 0 end), 0)::int`,
        todayCost: sql<number>`coalesce(sum(case when ${t.occurredAt} >= date_trunc('day', now()) then ${t.costUsd} else 0 end), 0)::float8`,
        todayCalls: sql<number>`coalesce(sum(case when ${t.occurredAt} >= date_trunc('day', now()) then 1 else 0 end), 0)::int`,

        d7Input: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '7 days' then ${t.inputTokens} else 0 end), 0)::int`,
        d7Output: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '7 days' then ${t.outputTokens} else 0 end), 0)::int`,
        d7Cached: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '7 days' then ${t.cachedInputTokens} else 0 end), 0)::int`,
        d7Total: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '7 days' then ${t.totalTokens} else 0 end), 0)::int`,
        d7Cost: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '7 days' then ${t.costUsd} else 0 end), 0)::float8`,
        d7Calls: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '7 days' then 1 else 0 end), 0)::int`,

        d30Input: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '30 days' then ${t.inputTokens} else 0 end), 0)::int`,
        d30Output: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '30 days' then ${t.outputTokens} else 0 end), 0)::int`,
        d30Cached: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '30 days' then ${t.cachedInputTokens} else 0 end), 0)::int`,
        d30Total: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '30 days' then ${t.totalTokens} else 0 end), 0)::int`,
        d30Cost: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '30 days' then ${t.costUsd} else 0 end), 0)::float8`,
        d30Calls: sql<number>`coalesce(sum(case when ${t.occurredAt} >= now() - interval '30 days' then 1 else 0 end), 0)::int`,

        allInput: aggCols.inputTokens,
        allOutput: aggCols.outputTokens,
        allCached: aggCols.cachedInputTokens,
        allTotal: aggCols.totalTokens,
        allCost: aggCols.costUsd,
        allCalls: aggCols.calls,
      })
      .from(t);

    const r = totalsRow[0] ?? {
      todayInput: 0, todayOutput: 0, todayCached: 0, todayTotal: 0, todayCost: 0, todayCalls: 0,
      d7Input: 0, d7Output: 0, d7Cached: 0, d7Total: 0, d7Cost: 0, d7Calls: 0,
      d30Input: 0, d30Output: 0, d30Cached: 0, d30Total: 0, d30Cost: 0, d30Calls: 0,
      allInput: 0, allOutput: 0, allCached: 0, allTotal: 0, allCost: 0, allCalls: 0,
    };

    const totals = {
      today: {
        inputTokens: Number(r.todayInput), outputTokens: Number(r.todayOutput),
        cachedInputTokens: Number(r.todayCached), totalTokens: Number(r.todayTotal),
        costUsd: Number(r.todayCost), calls: Number(r.todayCalls),
      },
      "7d": {
        inputTokens: Number(r.d7Input), outputTokens: Number(r.d7Output),
        cachedInputTokens: Number(r.d7Cached), totalTokens: Number(r.d7Total),
        costUsd: Number(r.d7Cost), calls: Number(r.d7Calls),
      },
      "30d": {
        inputTokens: Number(r.d30Input), outputTokens: Number(r.d30Output),
        cachedInputTokens: Number(r.d30Cached), totalTokens: Number(r.d30Total),
        costUsd: Number(r.d30Cost), calls: Number(r.d30Calls),
      },
      all: {
        inputTokens: Number(r.allInput), outputTokens: Number(r.allOutput),
        cachedInputTokens: Number(r.allCached), totalTokens: Number(r.allTotal),
        costUsd: Number(r.allCost), calls: Number(r.allCalls),
      },
    };

    const byModelRows = await db
      .select({
        model: t.model,
        provider: t.provider,
        ...aggCols,
      })
      .from(t)
      .groupBy(t.model, t.provider)
      .orderBy(desc(sql`coalesce(sum(${t.costUsd}), 0)`));

    const byAgentRows = await db
      .select({
        agent: t.agent,
        ...aggCols,
      })
      .from(t)
      .groupBy(t.agent)
      .orderBy(desc(sql`coalesce(sum(${t.costUsd}), 0)`));

    const recentRows = await db
      .select({
        id: t.id,
        occurredAt: t.occurredAt,
        agent: t.agent,
        model: t.model,
        provider: t.provider,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cachedInputTokens: t.cachedInputTokens,
        totalTokens: t.totalTokens,
        costUsd: t.costUsd,
      })
      .from(t)
      .orderBy(desc(t.occurredAt))
      .limit(20);

    const response: ApiResponse = {
      totals,
      byModel: byModelRows.map((row) => ({
        model: row.model,
        provider: row.provider,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cachedInputTokens: Number(row.cachedInputTokens),
        totalTokens: Number(row.totalTokens),
        costUsd: Number(row.costUsd),
        calls: Number(row.calls),
      })),
      byAgent: byAgentRows.map((row) => ({
        agent: row.agent,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cachedInputTokens: Number(row.cachedInputTokens),
        totalTokens: Number(row.totalTokens),
        costUsd: Number(row.costUsd),
        calls: Number(row.calls),
      })),
      recent: recentRows.map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        agent: row.agent,
        model: row.model,
        provider: row.provider,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedInputTokens: row.cachedInputTokens,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd != null ? Number(row.costUsd) : null,
      })),
    };

    return Response.json(response);
  } catch (err) {
    return errorResponse(err);
  }
}
