import Link from "next/link";
import { isUnlimited, type Quota } from "@marketing/shared-types";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  KV,
  PageHeader,
  Stat,
  StatusBadge,
} from "@/app/(admin)/ui";
import {
  getSuperWorkspaceUsage,
  listWorkspacePickerRows,
  type CostBucket,
  type SuperWorkspaceUsage,
} from "@/lib/super/usage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const fmtNumber = new Intl.NumberFormat("en-US");
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
const fmtDateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fmtDate = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

// Human labels for the metrics surfaced in the quotas table. Anything not in
// this map falls back to its raw key — better than a missing row.
const METRIC_LABELS: Partial<Record<Quota, string>> = {
  orchestrator_messages: "Chat messages",
  sub_agent_calls: "Sub-agent calls",
  single_post_runs: "Single-post generations",
  asset_pipeline_runs: "Asset pipeline runs",
  kb_embeds: "KB embeddings",
  kb_docs: "Knowledge docs",
  kb_doc_bytes: "Knowledge doc bytes",
  published_posts: "Published posts",
  llm_input_tokens: "LLM input tokens",
  llm_output_tokens: "LLM output tokens",
  llm_cost_usd_micros: "LLM cost (µUSD)",
};

export default async function SuperUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; q?: string }>;
}) {
  const { ws = "", q = "" } = await searchParams;
  const pickerRows = await listWorkspacePickerRows();
  const filtered = q
    ? pickerRows.filter(
        (w) =>
          w.name.toLowerCase().includes(q.toLowerCase()) ||
          w.slug.toLowerCase().includes(q.toLowerCase()) ||
          (w.ownerEmail ?? "").toLowerCase().includes(q.toLowerCase()),
      )
    : pickerRows;

  const usage = ws ? await getSuperWorkspaceUsage(ws) : null;

  return (
    <div>
      <PageHeader
        title="Usage"
        description="Pick a workspace to see plan, seats, monthly quota consumption, and LLM spend in dollars."
        meta={
          <>
            <Badge tone="danger" dot>
              superadmin
            </Badge>
            <Badge tone="info">{pickerRows.length} workspaces</Badge>
          </>
        }
      />

      <WorkspacePicker rows={filtered} selectedId={ws} query={q} />

      {!usage ? (
        <div className="mt-5">
          <EmptyState
            title={ws ? "Workspace not found" : "Select a workspace"}
            description={
              ws
                ? "That workspace id doesn't match any row in this instance."
                : "Pick one above to see its plan and usage."
            }
          />
        </div>
      ) : (
        <UsageDetail usage={usage} />
      )}
    </div>
  );
}

function WorkspacePicker({
  rows,
  selectedId,
  query,
}: {
  rows: Array<{
    id: string;
    name: string;
    slug: string;
    ownerEmail: string | null;
    planCode: string;
  }>;
  selectedId: string;
  query: string;
}) {
  return (
    <form
      method="GET"
      action="/super/usage"
      className="surface mb-5 px-3 py-2.5 flex items-center gap-2 flex-wrap"
    >
      <input
        type="search"
        name="q"
        defaultValue={query}
        placeholder="Filter by name, slug, owner email…"
        className="field flex-1 min-w-[200px]"
      />
      <select
        name="ws"
        defaultValue={selectedId}
        className="field flex-1 min-w-[260px]"
      >
        <option value="">— pick a workspace —</option>
        {rows.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} · /{w.slug} · {w.ownerEmail ?? "no owner email"} ·{" "}
            {w.planCode}
          </option>
        ))}
      </select>
      <button type="submit" className="btn btn-primary btn-sm">
        View usage
      </button>
      {(selectedId || query) && (
        <Link href="/super/usage" className="btn btn-ghost btn-sm">
          Reset
        </Link>
      )}
    </form>
  );
}

function UsageDetail({ usage }: { usage: SuperWorkspaceUsage }) {
  const { workspace, plan, subscription, seats, quotas, cost, byAgent, byModel, recent } =
    usage;

  return (
    <div className="space-y-5">
      <div className="surface p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/super/workspaces/${workspace.id}`}
            className="text-base font-semibold text-ink hover:underline"
          >
            {workspace.name}
          </Link>
          <div className="mt-0.5 text-xs text-mid">
            <span className="mono">/{workspace.slug}</span>
            {workspace.ownerEmail && (
              <>
                {" · owner "}
                <Link
                  href={`/super/users/${workspace.ownerUserId}`}
                  className="text-mid hover:text-ink hover:underline"
                >
                  {workspace.ownerEmail}
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="accent">{workspace.planName}</Badge>
          {subscription && <StatusBadge status={subscription.status} />}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="Today"
          value={fmtCostTight.format(cost.today.costUsd)}
          hint={`${fmtNumber.format(cost.today.totalTokens)} tokens · ${cost.today.calls} calls`}
        />
        <Stat
          label="Last 7 days"
          value={fmtCostTight.format(cost["7d"].costUsd)}
          hint={`${fmtNumber.format(cost["7d"].totalTokens)} tokens · ${cost["7d"].calls} calls`}
        />
        <Stat
          label="Last 30 days"
          value={fmtCostTight.format(cost["30d"].costUsd)}
          hint={`${fmtNumber.format(cost["30d"].totalTokens)} tokens · ${cost["30d"].calls} calls`}
          tone="accent"
        />
        <Stat
          label="All time"
          value={fmtCostTight.format(cost.all.costUsd)}
          hint={`${fmtNumber.format(cost.all.totalTokens)} tokens · ${cost.all.calls} calls`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-1">
          <CardHeader title="Plan & subscription" />
          <div className="mt-3">
            <KV label="Plan">
              <span className="text-ink">{workspace.planName}</span>{" "}
              <span className="text-faint mono text-xs">({workspace.planCode})</span>
            </KV>
            {plan?.priceMonthlyUsdCents != null && (
              <KV label="Price">
                {plan.priceMonthlyUsdCents === 0
                  ? "Free"
                  : `$${(plan.priceMonthlyUsdCents / 100).toFixed(0)}/mo`}
              </KV>
            )}
            {subscription ? (
              <>
                <KV label="Status">
                  <StatusBadge status={subscription.status} />
                </KV>
                <KV label="Provider">
                  <Badge tone="neutral">{subscription.provider}</Badge>
                </KV>
                <KV label="Period">{subscription.billingPeriod}</KV>
                <KV label="Renews">
                  {fmtDate.format(subscription.currentPeriodEnd)}
                </KV>
                {subscription.trialEnd && (
                  <KV label="Trial ends">
                    {fmtDate.format(subscription.trialEnd)}
                  </KV>
                )}
                <KV label="Cancel at end">
                  {subscription.cancelAtPeriodEnd ? (
                    <Badge tone="warn">yes</Badge>
                  ) : (
                    "no"
                  )}
                </KV>
              </>
            ) : (
              <p className="text-sm text-mid">
                No subscription row — workspace is on the default plan.
              </p>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Seats"
            description={`${seats.used} / ${
              isUnlimited(seats.cap) ? "∞" : seats.cap
            } used. Counts accepted members; pending invites don't consume a seat until accepted.`}
          />
          <div className="mt-3">
            <QuotaBar
              used={seats.used}
              cap={seats.cap}
              label="Seats used"
            />
            <div className="mt-4 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {seats.members.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-sm text-mid">
                        No members yet.
                      </td>
                    </tr>
                  ) : (
                    seats.members.map((m, i) => (
                      <tr key={`${m.userId ?? "invite"}-${i}`}>
                        <td>
                          {m.userId ? (
                            <Link
                              href={`/super/users/${m.userId}`}
                              className="text-ink hover:underline"
                            >
                              {m.email ?? "—"}
                            </Link>
                          ) : (
                            <span>{m.email ?? "—"}</span>
                          )}
                        </td>
                        <td>
                          <Badge tone="neutral">{m.role}</Badge>
                        </td>
                        <td>
                          {m.acceptedAt ? (
                            <Badge tone="success" dot>
                              active
                            </Badge>
                          ) : (
                            <Badge tone="warn" dot>
                              invited
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Plan quotas"
          description="Current-month usage against this plan's caps. Bars turn amber from 85% up to the cap and red only when exceeded."
        />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {quotas.length === 0 ? (
            <p className="text-sm text-mid">No quotas defined for this plan.</p>
          ) : (
            quotas.map((q) => (
              <QuotaBar
                key={q.metric}
                used={q.used}
                cap={q.cap}
                label={
                  METRIC_LABELS[q.metric as Quota] ??
                  q.metric.replaceAll("_", " ")
                }
              />
            ))
          )}
        </div>
      </Card>

      {byAgent.length > 0 && (
        <Card>
          <CardHeader
            title="LLM spend by agent"
            description="All-time totals across orchestrator + sub-agent calls."
          />
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="text-right">Calls</th>
                  <th className="text-right">Input</th>
                  <th className="text-right">Output</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {byAgent.map((row) => (
                  <CostRow key={row.agent} label={row.agent} bucket={row} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {byModel.length > 0 && (
        <Card>
          <CardHeader title="LLM spend by model" />
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">Calls</th>
                  <th className="text-right">Input</th>
                  <th className="text-right">Output</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {byModel.map((row) => (
                  <CostRow
                    key={`${row.provider}:${row.model}`}
                    label={
                      <>
                        <div className="text-ink">{row.model}</div>
                        <div className="text-[11px] text-mid">{row.provider}</div>
                      </>
                    }
                    bucket={row}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {recent.length > 0 && (
        <Card>
          <CardHeader title="Recent calls" description="Latest 15." />
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Agent</th>
                  <th>Model</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td className="text-xs text-mid whitespace-nowrap">
                      {fmtDateTime.format(r.occurredAt)}
                    </td>
                    <td className="text-ink">{r.agent}</td>
                    <td className="text-ink">{r.model}</td>
                    <td className="text-right tabular-nums text-ink">
                      {fmtNumber.format(r.totalTokens)}
                    </td>
                    <td className="text-right tabular-nums text-ink">
                      {r.costUsd != null ? fmtCost.format(r.costUsd) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {byAgent.length === 0 && byModel.length === 0 && (
        <EmptyState
          title="No LLM calls recorded"
          description="This workspace hasn't run the orchestrator or any sub-agent yet."
        />
      )}
    </div>
  );
}

function CostRow({
  label,
  bucket,
}: {
  label: React.ReactNode;
  bucket: CostBucket;
}) {
  return (
    <tr>
      <td>{label}</td>
      <td className="text-right tabular-nums text-ink">
        {fmtNumber.format(bucket.calls)}
      </td>
      <td className="text-right tabular-nums text-ink">
        {fmtNumber.format(bucket.inputTokens)}
      </td>
      <td className="text-right tabular-nums text-ink">
        {fmtNumber.format(bucket.outputTokens)}
      </td>
      <td className="text-right tabular-nums text-ink">
        {fmtNumber.format(bucket.totalTokens)}
      </td>
      <td className="text-right tabular-nums text-ink">
        {fmtCost.format(bucket.costUsd)}
      </td>
    </tr>
  );
}

function QuotaBar({
  label,
  used,
  cap,
}: {
  label: string;
  used: number;
  cap: number;
}) {
  const unlimited = isUnlimited(cap);
  const fraction = unlimited ? 0 : cap > 0 ? used / cap : 0;
  const pct = Math.min(100, Math.round(fraction * 100));
  const tone =
    unlimited
      ? "ok"
      : fraction > 1
        ? "danger"
        : fraction >= 0.85
          ? "warn"
          : "ok";

  const barColor =
    tone === "danger"
      ? "bg-[var(--danger)]"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-[var(--accent)]";

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="text-sm font-medium text-ink capitalize">{label}</div>
        <div className="text-sm tabular-nums text-ink">
          {fmtNumber.format(used)}{" "}
          <span className="text-faint">
            / {unlimited ? "∞" : fmtNumber.format(cap)}
          </span>
        </div>
      </div>
      <div className="h-1.5 w-full rounded-full bg-[var(--surface-2)] overflow-hidden">
        <div
          className={`h-full ${barColor} transition-[width] duration-500`}
          style={{ width: unlimited ? "100%" : `${pct}%` }}
        />
      </div>
    </div>
  );
}
