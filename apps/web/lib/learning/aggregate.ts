/**
 * Learning loop aggregations.
 *
 * Pulls signal from the `agent_feedback` table written on every approval
 * decision. Returns the structured shape consumed by the /admin/learning
 * page and the learning-synthesis workflow.
 *
 * No LLM here — deterministic SQL. The synthesis workflow takes these
 * numbers + raw rejection reasons, asks an LLM to find themes, and writes
 * the themes back to the KB as 'playbook' / 'past_content' documents that
 * the content sub-agent picks up via findCommonMistakes on the next run.
 */
import { sql, and, gte, eq, isNotNull, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";

export type LearningSummary = {
  totals: {
    decisions: number;
    approved: number;
    changes_requested: number;
    rejected: number;
    approvalRate: number;
    rejectionRate: number;
    changesRate: number;
  };
  editDistance: {
    count: number;
    avg: number | null;
    p50: number | null;
    p90: number | null;
  };
  byChannel: Array<{
    channel: string;
    approved: number;
    rejected: number;
    changes: number;
    approvalRate: number;
  }>;
  daily: Array<{
    day: string;
    approved: number;
    rejected: number;
    changes: number;
  }>;
  topReasons: Array<{
    reason: string;
    count: number;
    decision: "rejected" | "changes_requested";
    sampleContentId: string | null;
  }>;
  recentRejections: Array<{
    feedbackId: string;
    contentId: string;
    contentTitle: string;
    decision: "rejected" | "changes_requested";
    reason: string | null;
    editDistance: number | null;
    decidedAt: string;
  }>;
};

export type AggregateOptions = {
  /** Cutoff in days (default 30). */
  windowDays?: number;
  /** When set, scope to a single channel. */
  channel?: string;
  /** Cap on lists (default 10). */
  limit?: number;
};

export async function aggregateLearningSignal(
  opts: AggregateOptions = {},
): Promise<LearningSummary> {
  const db = getDb();
  const windowDays = opts.windowDays ?? 30;
  const limit = opts.limit ?? 10;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [totalsRow] = await db
    .select({
      decisions: sql<number>`count(*)::int`,
      approved: sql<number>`count(*) filter (where decision = 'approved')::int`,
      changes_requested: sql<number>`count(*) filter (where decision = 'changes_requested')::int`,
      rejected: sql<number>`count(*) filter (where decision = 'rejected')::int`,
      avgEdit: sql<number | null>`avg(edit_distance)::float`,
      countEdit: sql<number>`count(edit_distance)::int`,
      p50Edit: sql<number | null>`percentile_cont(0.5) within group (order by edit_distance)::float`,
      p90Edit: sql<number | null>`percentile_cont(0.9) within group (order by edit_distance)::float`,
    })
    .from(schema.agentFeedback)
    .where(gte(schema.agentFeedback.decidedAt, since));

  const t = totalsRow ?? {
    decisions: 0,
    approved: 0,
    changes_requested: 0,
    rejected: 0,
    avgEdit: null as number | null,
    countEdit: 0,
    p50Edit: null as number | null,
    p90Edit: null as number | null,
  };

  const total = Math.max(1, t.decisions);
  const totals = {
    decisions: t.decisions,
    approved: t.approved,
    changes_requested: t.changes_requested,
    rejected: t.rejected,
    approvalRate: t.approved / total,
    rejectionRate: t.rejected / total,
    changesRate: t.changes_requested / total,
  };

  const channelRows = await db
    .select({
      channel: schema.publishJobs.channel,
      approved: sql<number>`count(*) filter (where ${schema.agentFeedback.decision} = 'approved')::int`,
      rejected: sql<number>`count(*) filter (where ${schema.agentFeedback.decision} = 'rejected')::int`,
      changes: sql<number>`count(*) filter (where ${schema.agentFeedback.decision} = 'changes_requested')::int`,
    })
    .from(schema.agentFeedback)
    .innerJoin(
      schema.publishJobs,
      eq(schema.publishJobs.contentId, schema.agentFeedback.contentId),
    )
    .where(gte(schema.agentFeedback.decidedAt, since))
    .groupBy(schema.publishJobs.channel);

  const byChannel = channelRows.map((r) => {
    const t = r.approved + r.rejected + r.changes || 1;
    return {
      channel: r.channel as string,
      approved: r.approved,
      rejected: r.rejected,
      changes: r.changes,
      approvalRate: r.approved / t,
    };
  });

  const dailyRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${schema.agentFeedback.decidedAt}), 'YYYY-MM-DD')`,
      approved: sql<number>`count(*) filter (where decision = 'approved')::int`,
      rejected: sql<number>`count(*) filter (where decision = 'rejected')::int`,
      changes: sql<number>`count(*) filter (where decision = 'changes_requested')::int`,
    })
    .from(schema.agentFeedback)
    .where(gte(schema.agentFeedback.decidedAt, since))
    .groupBy(sql`date_trunc('day', ${schema.agentFeedback.decidedAt})`)
    .orderBy(sql`date_trunc('day', ${schema.agentFeedback.decidedAt})`);

  const reasonRows = await db
    .select({
      reason: schema.agentFeedback.reason,
      decision: schema.agentFeedback.decision,
      count: sql<number>`count(*)::int`,
      sampleContentId: sql<string>`min(${schema.agentFeedback.contentId}::text)`,
    })
    .from(schema.agentFeedback)
    .where(
      and(
        gte(schema.agentFeedback.decidedAt, since),
        sql`${schema.agentFeedback.decision} in ('rejected','changes_requested')`,
        isNotNull(schema.agentFeedback.reason),
      ),
    )
    .groupBy(schema.agentFeedback.reason, schema.agentFeedback.decision)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  const topReasons = reasonRows
    .filter((r) => r.reason && r.reason.trim().length > 0)
    .map((r) => ({
      reason: r.reason!.trim(),
      count: r.count,
      decision: r.decision as "rejected" | "changes_requested",
      sampleContentId: r.sampleContentId ?? null,
    }));

  const recentRows = await db
    .select({
      feedbackId: schema.agentFeedback.id,
      contentId: schema.agentFeedback.contentId,
      contentTitle: schema.contentItems.title,
      decision: schema.agentFeedback.decision,
      reason: schema.agentFeedback.reason,
      editDistance: schema.agentFeedback.editDistance,
      decidedAt: schema.agentFeedback.decidedAt,
    })
    .from(schema.agentFeedback)
    .innerJoin(
      schema.contentItems,
      eq(schema.contentItems.id, schema.agentFeedback.contentId),
    )
    .where(
      and(
        gte(schema.agentFeedback.decidedAt, since),
        sql`${schema.agentFeedback.decision} in ('rejected','changes_requested')`,
      ),
    )
    .orderBy(desc(schema.agentFeedback.decidedAt))
    .limit(limit);

  const recentRejections = recentRows.map((r) => ({
    feedbackId: r.feedbackId,
    contentId: r.contentId,
    contentTitle: r.contentTitle,
    decision: r.decision as "rejected" | "changes_requested",
    reason: r.reason,
    editDistance: r.editDistance,
    decidedAt: r.decidedAt.toISOString(),
  }));

  return {
    totals,
    editDistance: {
      count: t.countEdit,
      avg: t.avgEdit,
      p50: t.p50Edit,
      p90: t.p90Edit,
    },
    byChannel,
    daily: dailyRows,
    topReasons,
    recentRejections,
  };
}
