// Server component. Renders the LLM usage / cost section on the settings
// page. Pulls aggregates straight from the llm_usage table — no API call
// needed since we're already on the server. The /api/usage route exists for
// any client/agent caller that wants the same shape.

import { sql, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";

type Bucket = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
};

type UsageData = {
  totals: { today: Bucket; "7d": Bucket; "30d": Bucket; all: Bucket };
  byModel: Array<{ model: string; provider: string } & Bucket>;
  byAgent: Array<{ agent: string } & Bucket>;
  recent: Array<{
    id: string;
    occurredAt: Date;
    agent: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: string | null;
  }>;
};

async function loadUsage(): Promise<UsageData> {
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
    .from(t);

  const r = totalsRow ?? {
    todayInput: 0, todayOutput: 0, todayCached: 0, todayTotal: 0, todayCost: 0, todayCalls: 0,
    d7Input: 0, d7Output: 0, d7Cached: 0, d7Total: 0, d7Cost: 0, d7Calls: 0,
    d30Input: 0, d30Output: 0, d30Cached: 0, d30Total: 0, d30Cost: 0, d30Calls: 0,
    allInput: 0, allOutput: 0, allCached: 0, allTotal: 0, allCost: 0, allCalls: 0,
  };

  const totals: UsageData["totals"] = {
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
    .select({ model: t.model, provider: t.provider, ...aggCols })
    .from(t)
    .groupBy(t.model, t.provider)
    .orderBy(desc(sql`coalesce(sum(${t.costUsd}), 0)`));

  const byAgentRows = await db
    .select({ agent: t.agent, ...aggCols })
    .from(t)
    .groupBy(t.agent)
    .orderBy(desc(sql`coalesce(sum(${t.costUsd}), 0)`));

  const recent = await db
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
    .limit(10);

  return {
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
    recent,
  };
}

const fmtTokens = new Intl.NumberFormat("en-US");
const fmtCost = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const fmtCostTight = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fmtTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function StatCard({
  label,
  bucket,
}: {
  label: string;
  bucket: Bucket;
}) {
  return (
    <div className="surface-2 p-3">
      <div className="text-[11px] uppercase tracking-wide text-mid">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink">
        {fmtCostTight.format(bucket.costUsd)}
      </div>
      <div className="mt-1 text-xs text-mid">
        {fmtTokens.format(bucket.totalTokens)} tokens · {bucket.calls} call
        {bucket.calls === 1 ? "" : "s"}
      </div>
    </div>
  );
}

export async function UsagePanel() {
  let data: UsageData;
  try {
    data = await loadUsage();
  } catch (err) {
    return (
      <section className="surface p-5">
        <h2 className="text-base font-semibold text-ink">LLM usage & cost</h2>
        <p className="mt-2 text-sm text-[var(--danger)]">
          Failed to load usage data: {(err as Error).message}
        </p>
      </section>
    );
  }

  const noData = data.totals.all.calls === 0;

  return (
    <section className="surface p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-ink">LLM usage & cost</h2>
        <p className="mt-0.5 text-sm text-mid">
          Tokens and estimated USD cost across orchestrator and sub-agent
          calls. Cost is computed at write time from list prices in
          shared-types — actual invoiced cost may differ.
        </p>
      </div>

      {noData ? (
        <p className="text-sm text-mid">
          No LLM calls recorded yet. Run the orchestrator or any sub-agent and
          this will populate.
        </p>
      ) : (
        <>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Today" bucket={data.totals.today} />
            <StatCard label="Last 7 days" bucket={data.totals["7d"]} />
            <StatCard label="Last 30 days" bucket={data.totals["30d"]} />
            <StatCard label="All time" bucket={data.totals.all} />
          </div>

          {data.byModel.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-medium text-ink mb-2">By model</h3>
              <div className="surface-2 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-mid">
                    <tr className="border-b border-[var(--border)]">
                      <th className="text-left px-3 py-2 font-medium">Model</th>
                      <th className="text-right px-3 py-2 font-medium">Calls</th>
                      <th className="text-right px-3 py-2 font-medium">Input</th>
                      <th className="text-right px-3 py-2 font-medium">Output</th>
                      <th className="text-right px-3 py-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((m) => (
                      <tr
                        key={`${m.provider}:${m.model}`}
                        className="border-t border-[var(--border)] first:border-t-0"
                      >
                        <td className="px-3 py-2">
                          <div className="text-ink">{m.model}</div>
                          <div className="text-[11px] text-mid">{m.provider}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {fmtTokens.format(m.calls)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {fmtTokens.format(m.inputTokens)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {fmtTokens.format(m.outputTokens)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {fmtCost.format(m.costUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.byAgent.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-medium text-ink mb-2">By agent</h3>
              <div className="surface-2 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-mid">
                    <tr className="border-b border-[var(--border)]">
                      <th className="text-left px-3 py-2 font-medium">Agent</th>
                      <th className="text-right px-3 py-2 font-medium">Calls</th>
                      <th className="text-right px-3 py-2 font-medium">Tokens</th>
                      <th className="text-right px-3 py-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byAgent.map((a) => (
                      <tr
                        key={a.agent}
                        className="border-t border-[var(--border)] first:border-t-0"
                      >
                        <td className="px-3 py-2 text-ink">{a.agent}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {fmtTokens.format(a.calls)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {fmtTokens.format(a.totalTokens)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {fmtCost.format(a.costUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.recent.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-medium text-ink mb-2">Recent calls</h3>
              <div className="surface-2 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-mid">
                    <tr className="border-b border-[var(--border)]">
                      <th className="text-left px-3 py-2 font-medium">When</th>
                      <th className="text-left px-3 py-2 font-medium">Agent</th>
                      <th className="text-left px-3 py-2 font-medium">Model</th>
                      <th className="text-right px-3 py-2 font-medium">Tokens</th>
                      <th className="text-right px-3 py-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((row) => (
                      <tr
                        key={row.id}
                        className="border-t border-[var(--border)] first:border-t-0"
                      >
                        <td className="px-3 py-2 text-mid whitespace-nowrap">
                          {fmtTime.format(row.occurredAt)}
                        </td>
                        <td className="px-3 py-2 text-ink">{row.agent}</td>
                        <td className="px-3 py-2 text-ink">{row.model}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {fmtTokens.format(row.totalTokens)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {row.costUsd != null
                            ? fmtCost.format(Number(row.costUsd))
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
