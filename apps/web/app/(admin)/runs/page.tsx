/**
 * /runs — Workflow run cost dashboard.
 *
 * Lists every workflow_runs row with a rolled-up llm_usage cost and token
 * total joined in. Click through to the detail view (existing
 * /api/usage/by-workflow/[id]) for the per-call breakdown.
 */
import Link from "next/link";
import { sql, eq, desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { PageHeader, Badge } from "../ui";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "info" | "warn" | "success" | "violet"> = {
  queued: "info",
  running: "violet",
  completed: "success",
  failed: "warn",
  cancelled: "warn",
};

const ENGINE_LABEL: Record<string, string> = {
  custom: "Custom (legacy)",
  vercel: "Vercel",
  cloudflare: "Cloudflare",
};

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; limit?: string }>;
}) {
  const params = await searchParams;
  const limit = Math.min(200, Math.max(10, Number(params.limit ?? 50) || 50));
  const status = params.status;

  const db = getDb();
  const r = schema.workflowRuns;
  const u = schema.llmUsage;

  const baseQuery = db
    .select({
      id: r.id,
      engine: r.engine,
      kind: r.kind,
      status: r.status,
      request: r.request,
      threadRef: r.threadRef,
      campaignId: r.campaignId,
      contentId: r.contentId,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      error: r.error,
      totalTokens: sql<number>`coalesce(sum(${u.totalTokens}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${u.costUsd}), 0)::float8`,
      llmCalls: sql<number>`count(${u.id})::int`,
    })
    .from(r)
    .leftJoin(u, eq(u.workflowRunId, r.id))
    .groupBy(r.id);

  const filtered = status
    ? baseQuery.where(eq(r.status, status as "queued" | "running" | "completed" | "failed" | "cancelled"))
    : baseQuery;

  const rows = await filtered.orderBy(desc(r.startedAt)).limit(limit);

  const totals = rows.reduce(
    (acc, row) => ({
      tokens: acc.tokens + Number(row.totalTokens),
      cost: acc.cost + Number(row.costUsd),
      count: acc.count + 1,
    }),
    { tokens: 0, cost: 0, count: 0 },
  );

  return (
    <>
      <PageHeader
        title="Workflow runs"
        description="Every workflow run with its rolled-up LLM cost. Click a row to see the per-call token breakdown."
        meta={
          <span className="text-faint text-[12px]">
            {totals.count} run(s) · ${totals.cost.toFixed(2)} · {totals.tokens.toLocaleString()} tokens
          </span>
        }
      />

      <nav className="mb-4 flex gap-1 text-[12px]">
        {(["all", "running", "completed", "failed", "cancelled"] as const).map(
          (s) => {
            const active = (status ?? "all") === s;
            const href = s === "all" ? "/runs" : `/runs?status=${s}`;
            return (
              <Link
                key={s}
                href={href}
                className={`rounded-md px-3 py-1.5 ${
                  active
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--surface-2)] text-mid hover:text-ink"
                }`}
              >
                {s}
              </Link>
            );
          },
        )}
      </nav>

      {rows.length === 0 ? (
        <div className="surface p-8 text-center text-mid">
          No workflow runs in this view.
        </div>
      ) : (
        <div className="surface overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="text-faint">
              <tr className="border-b border-[var(--border)]">
                <th className="text-left font-normal py-2 px-3">When</th>
                <th className="text-left font-normal py-2 px-3">Kind</th>
                <th className="text-left font-normal py-2 px-3">Engine</th>
                <th className="text-left font-normal py-2 px-3">Status</th>
                <th className="text-left font-normal py-2 px-3">Request</th>
                <th className="text-right font-normal py-2 px-3">Calls</th>
                <th className="text-right font-normal py-2 px-3">Tokens</th>
                <th className="text-right font-normal py-2 px-3">Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-[var(--border)] hover:bg-[var(--surface-2)]"
                >
                  <td className="py-2 px-3 text-mid">
                    {row.startedAt
                      ? new Date(row.startedAt).toLocaleString()
                      : "—"}
                  </td>
                  <td className="py-2 px-3 mono">{row.kind}</td>
                  <td className="py-2 px-3">
                    {ENGINE_LABEL[row.engine] ?? row.engine}
                  </td>
                  <td className="py-2 px-3">
                    <Badge tone={STATUS_TONE[row.status] ?? "info"}>
                      {row.status}
                    </Badge>
                  </td>
                  <td className="py-2 px-3 text-mid max-w-[420px] truncate">
                    {row.request || "(empty)"}
                  </td>
                  <td className="py-2 px-3 text-right">{row.llmCalls}</td>
                  <td className="py-2 px-3 text-right">
                    {Number(row.totalTokens).toLocaleString()}
                  </td>
                  <td className="py-2 px-3 text-right">
                    {Number(row.costUsd) > 0
                      ? `$${Number(row.costUsd).toFixed(4)}`
                      : "—"}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <Link
                      href={`/api/usage/by-workflow/${row.id}`}
                      className="text-[var(--accent)] hover:underline"
                      target="_blank"
                    >
                      detail
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
