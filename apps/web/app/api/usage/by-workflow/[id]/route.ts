/**
 * GET /api/usage/by-workflow/[id]
 *
 * Sums llm_usage rows for a single workflow_runs.id and lists the per-call
 * detail. Use to answer "how many tokens / how much cost did this run burn?"
 *
 * Auth: admin session cookie or internal token (matches /api/usage).
 */

import { sql, eq, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type ApiResponse = {
  workflowRunId: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    calls: number;
  };
  byAgent: Array<{
    agent: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    calls: number;
  }>;
  byModel: Array<{
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    calls: number;
  }>;
  calls: Array<{
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!isInternal(request)) await getRequestActor();
    const { id } = await params;
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

    const totalsRow = await db
      .select(aggCols)
      .from(t)
      .where(eq(t.workflowRunId, id));

    const totals = totalsRow[0] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      calls: 0,
    };

    const byAgentRows = await db
      .select({ agent: t.agent, ...aggCols })
      .from(t)
      .where(eq(t.workflowRunId, id))
      .groupBy(t.agent)
      .orderBy(desc(sql`coalesce(sum(${t.totalTokens}), 0)`));

    const byModelRows = await db
      .select({ model: t.model, provider: t.provider, ...aggCols })
      .from(t)
      .where(eq(t.workflowRunId, id))
      .groupBy(t.model, t.provider)
      .orderBy(desc(sql`coalesce(sum(${t.totalTokens}), 0)`));

    const callRows = await db
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
      .where(eq(t.workflowRunId, id))
      .orderBy(desc(t.occurredAt));

    const response: ApiResponse = {
      workflowRunId: id,
      totals: {
        inputTokens: Number(totals.inputTokens),
        outputTokens: Number(totals.outputTokens),
        cachedInputTokens: Number(totals.cachedInputTokens),
        totalTokens: Number(totals.totalTokens),
        costUsd: Number(totals.costUsd),
        calls: Number(totals.calls),
      },
      byAgent: byAgentRows.map((row) => ({
        agent: row.agent,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cachedInputTokens: Number(row.cachedInputTokens),
        totalTokens: Number(row.totalTokens),
        costUsd: Number(row.costUsd),
        calls: Number(row.calls),
      })),
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
      calls: callRows.map((row) => ({
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
