import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  DEFAULT_PLANS,
  type PlanCode,
  type Quota,
  type QuotaSet,
  type SubscriptionStatus,
} from "@marketing/shared-types";
import { emailsByUserId } from "@/lib/supabase/admin";

export type CostBucket = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
};

export type SuperWorkspaceUsage = {
  workspace: {
    id: string;
    name: string;
    slug: string;
    planCode: PlanCode | string;
    planName: string;
    ownerEmail: string | null;
    ownerUserId: string;
  };
  plan: {
    code: PlanCode | string;
    name: string;
    description: string;
    priceMonthlyUsdCents: number | null;
    quotas: QuotaSet;
  } | null;
  subscription: {
    id: string;
    status: SubscriptionStatus;
    provider: string;
    billingPeriod: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    trialEnd: Date | null;
  } | null;
  // Seats are counted distinctly from quota counters because the counter
  // is monthly-rolled but seats are a live headcount that must always
  // reflect the current membership table.
  seats: {
    used: number;
    cap: number;
    members: Array<{
      userId: string | null;
      email: string | null;
      role: string;
      acceptedAt: Date | null;
    }>;
  };
  quotas: Array<{
    metric: Quota | string;
    used: number;
    cap: number;
  }>;
  cost: {
    today: CostBucket;
    "7d": CostBucket;
    "30d": CostBucket;
    all: CostBucket;
  };
  byAgent: Array<{ agent: string } & CostBucket>;
  byModel: Array<{ model: string; provider: string } & CostBucket>;
  recent: Array<{
    id: string;
    occurredAt: Date;
    agent: string;
    model: string;
    provider: string;
    totalTokens: number;
    costUsd: number | null;
  }>;
};

function monthBoundsIso(now = new Date()): { startIso: string; endIso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return {
    startIso: start.toISOString().slice(0, 10),
    endIso: end.toISOString().slice(0, 10),
  };
}

export async function getSuperWorkspaceUsage(
  workspaceId: string,
): Promise<SuperWorkspaceUsage | null> {
  const db = getDb();

  const wsRows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const w = wsRows[0];
  if (!w) return null;

  const [planRows, subRows, memberRows] = await Promise.all([
    db.select().from(schema.plans).where(eq(schema.plans.id, w.planId)).limit(1),
    db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.workspaceId, workspaceId))
      .orderBy(desc(schema.subscriptions.createdAt))
      .limit(1),
    db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
      .orderBy(desc(schema.workspaceMembers.createdAt)),
  ]);

  const emailByUser = await emailsByUserId([
    w.ownerUserId,
    ...memberRows.map((m) => m.userId),
  ]);

  const planRow = planRows[0] ?? null;
  // Prefer the DB plan row's quotas; fall back to the shared-types default
  // (e.g. for fresh installs that haven't seeded yet) so the page still
  // renders sensible caps. If both are missing we leave plan null.
  const planDefault = DEFAULT_PLANS.find(
    (p) => p.code === (planRow?.code as PlanCode | undefined),
  );
  const planQuotas: QuotaSet | null =
    (planRow?.quotas as QuotaSet | null) ?? planDefault?.quotas ?? null;
  const plan: SuperWorkspaceUsage["plan"] =
    planRow && planQuotas
      ? {
          code: planRow.code,
          name: planRow.name,
          description: planRow.description ?? "",
          priceMonthlyUsdCents: planRow.priceMonthlyUsdCents,
          quotas: planQuotas,
        }
      : null;
  const sub = subRows[0] ?? null;

  const acceptedMembers = memberRows.filter((m) => m.acceptedAt !== null);
  const seats = {
    used: acceptedMembers.length,
    cap: planQuotas?.seats ?? 0,
    members: memberRows.map((m) => ({
      userId: m.userId,
      email: m.userId
        ? emailByUser.get(m.userId) ?? null
        : m.invitedEmail ?? null,
      role: m.role,
      acceptedAt: m.acceptedAt,
    })),
  };

  // Current-month quota counters. Compare value against planQuotas to render
  // progress bars in the UI.
  const { startIso, endIso } = monthBoundsIso();
  const counterRows = await db
    .select({
      metric: schema.usageCounters.metric,
      value: schema.usageCounters.value,
    })
    .from(schema.usageCounters)
    .where(
      and(
        eq(schema.usageCounters.workspaceId, workspaceId),
        gte(schema.usageCounters.periodStart, startIso),
        lte(schema.usageCounters.periodStart, endIso),
      ),
    );
  const usedByMetric = new Map<string, number>();
  for (const r of counterRows) usedByMetric.set(r.metric, Number(r.value));

  // Surface every quota the plan caps, plus any metric that has usage even
  // if it isn't capped (so a metric with non-zero usage on free plan still
  // shows up as 0/0 instead of disappearing).
  const quotaKeys = new Set<string>(
    Object.keys(planQuotas ?? ({} as QuotaSet)),
  );
  for (const k of usedByMetric.keys()) quotaKeys.add(k);
  // seats is handled above, drop the duplicate row.
  quotaKeys.delete("seats");
  const quotas = Array.from(quotaKeys)
    .map((metric) => ({
      metric,
      used: usedByMetric.get(metric) ?? 0,
      cap:
        planQuotas && metric in planQuotas
          ? planQuotas[metric as Quota]
          : 0,
    }))
    .sort((a, b) => a.metric.localeCompare(b.metric));

  // LLM usage / cost — same single-pass bucket query the /api/usage handler
  // uses, scoped to this workspace.
  const t = schema.llmUsage;
  const wsFilter = eq(t.workspaceId, workspaceId);

  const aggCols = {
    inputTokens: sql<number>`coalesce(sum(${t.inputTokens}), 0)::int`,
    outputTokens: sql<number>`coalesce(sum(${t.outputTokens}), 0)::int`,
    cachedInputTokens: sql<number>`coalesce(sum(${t.cachedInputTokens}), 0)::int`,
    totalTokens: sql<number>`coalesce(sum(${t.totalTokens}), 0)::int`,
    costUsd: sql<number>`coalesce(sum(${t.costUsd}), 0)::float8`,
    calls: sql<number>`count(*)::int`,
  };

  const [totalsRow] = await db
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
    .from(t)
    .where(wsFilter);

  const r = totalsRow ?? {
    todayInput: 0, todayOutput: 0, todayCached: 0, todayTotal: 0, todayCost: 0, todayCalls: 0,
    d7Input: 0, d7Output: 0, d7Cached: 0, d7Total: 0, d7Cost: 0, d7Calls: 0,
    d30Input: 0, d30Output: 0, d30Cached: 0, d30Total: 0, d30Cost: 0, d30Calls: 0,
    allInput: 0, allOutput: 0, allCached: 0, allTotal: 0, allCost: 0, allCalls: 0,
  };

  const cost: SuperWorkspaceUsage["cost"] = {
    today: {
      inputTokens: Number(r.todayInput),
      outputTokens: Number(r.todayOutput),
      cachedInputTokens: Number(r.todayCached),
      totalTokens: Number(r.todayTotal),
      costUsd: Number(r.todayCost),
      calls: Number(r.todayCalls),
    },
    "7d": {
      inputTokens: Number(r.d7Input),
      outputTokens: Number(r.d7Output),
      cachedInputTokens: Number(r.d7Cached),
      totalTokens: Number(r.d7Total),
      costUsd: Number(r.d7Cost),
      calls: Number(r.d7Calls),
    },
    "30d": {
      inputTokens: Number(r.d30Input),
      outputTokens: Number(r.d30Output),
      cachedInputTokens: Number(r.d30Cached),
      totalTokens: Number(r.d30Total),
      costUsd: Number(r.d30Cost),
      calls: Number(r.d30Calls),
    },
    all: {
      inputTokens: Number(r.allInput),
      outputTokens: Number(r.allOutput),
      cachedInputTokens: Number(r.allCached),
      totalTokens: Number(r.allTotal),
      costUsd: Number(r.allCost),
      calls: Number(r.allCalls),
    },
  };

  const [byAgentRows, byModelRows, recentRows] = await Promise.all([
    db
      .select({ agent: t.agent, ...aggCols })
      .from(t)
      .where(wsFilter)
      .groupBy(t.agent)
      .orderBy(desc(sql`coalesce(sum(${t.costUsd}), 0)`)),
    db
      .select({ model: t.model, provider: t.provider, ...aggCols })
      .from(t)
      .where(wsFilter)
      .groupBy(t.model, t.provider)
      .orderBy(desc(sql`coalesce(sum(${t.costUsd}), 0)`)),
    db
      .select({
        id: t.id,
        occurredAt: t.occurredAt,
        agent: t.agent,
        model: t.model,
        provider: t.provider,
        totalTokens: t.totalTokens,
        costUsd: t.costUsd,
      })
      .from(t)
      .where(wsFilter)
      .orderBy(desc(t.occurredAt))
      .limit(15),
  ]);

  const ownerEmail = emailByUser.get(w.ownerUserId) ?? null;

  return {
    workspace: {
      id: w.id,
      name: w.name,
      slug: w.slug,
      planCode: planRow?.code ?? "—",
      planName: planRow?.name ?? "—",
      ownerEmail,
      ownerUserId: w.ownerUserId,
    },
    plan,
    subscription: sub
      ? {
          id: sub.id,
          status: sub.status,
          provider: sub.provider,
          billingPeriod: sub.billingPeriod,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          trialEnd: sub.trialEnd,
        }
      : null,
    seats,
    quotas,
    cost,
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
    recent: recentRows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      agent: row.agent,
      model: row.model,
      provider: row.provider,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd != null ? Number(row.costUsd) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lightweight workspace picker (id + name + slug + owner email) for the
// /super/usage selector. Avoids the heavier listSuperWorkspaces which pulls
// member counts and subscriptions for every row.
// ---------------------------------------------------------------------------

export type WorkspacePickerRow = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  planCode: string;
};

export async function listWorkspacePickerRows(): Promise<WorkspacePickerRow[]> {
  const db = getDb();
  const [rows, planRows] = await Promise.all([
    db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
        planId: schema.workspaces.planId,
        ownerUserId: schema.workspaces.ownerUserId,
      })
      .from(schema.workspaces)
      .where(isNull(schema.workspaces.deletedAt))
      .orderBy(schema.workspaces.name),
    db.select({ id: schema.plans.id, code: schema.plans.code }).from(schema.plans),
  ]);
  const planById = new Map(planRows.map((p) => [p.id, p.code as string]));
  const emailByUser = await emailsByUserId(rows.map((r) => r.ownerUserId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    ownerEmail: emailByUser.get(r.ownerUserId) ?? null,
    planCode: planById.get(r.planId) ?? "—",
  }));
}

