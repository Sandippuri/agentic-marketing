// Plan + usage card on /settings. Workspace-scoped — every viewer sees only
// their own workspace's quotas and consumption. Designed to read like a
// consumer SaaS dashboard (Claude / Linear): plan name, renewal date, a few
// progress bars, no raw token / dollar internals. Operators looking for the
// per-model cost breakdown should go through /super.

import { and, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { DEFAULT_PLANS, type Quota } from "@marketing/shared-types";
import { getWorkspaceContext } from "@/lib/billing";

type QuotaRow = {
  metric: Quota;
  label: string;
  description: string;
  used: number;
  cap: number;
};

// Quotas to surface, in display order. We pick metrics a user can act on or
// recognise; raw token counts stay hidden behind the operator dashboard.
const SHOWN_QUOTAS: Array<{
  metric: Quota;
  label: string;
  description: string;
}> = [
  {
    metric: "single_post_runs",
    label: "Generations",
    description: "Posts the AI has drafted this period.",
  },
  {
    metric: "published_posts",
    label: "Published posts",
    description: "Posts sent to a connected channel.",
  },
  {
    metric: "orchestrator_messages",
    label: "Chat messages",
    description: "Messages exchanged with the marketing chat.",
  },
  {
    metric: "kb_docs",
    label: "Knowledge docs",
    description: "Documents stored in your knowledge base.",
  },
];

function monthBounds(now = new Date()): {
  start: Date;
  end: Date;
  startStr: string;
  endStr: string;
} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return { start, end, startStr: toIso(start), endStr: toIso(end) };
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function daysUntil(d: Date): number {
  const ms = d.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

export async function PlanUsageCard() {
  const ctx = await getWorkspaceContext();
  const db = getDb();

  const { end, startStr, endStr } = monthBounds();

  const [counterRows, subRows] = await Promise.all([
    db
      .select({
        metric: schema.usageCounters.metric,
        value: schema.usageCounters.value,
      })
      .from(schema.usageCounters)
      .where(
        and(
          eq(schema.usageCounters.workspaceId, ctx.workspaceId),
          gte(schema.usageCounters.periodStart, startStr),
          lte(schema.usageCounters.periodStart, endStr),
        ),
      ),
    db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.workspaceId, ctx.workspaceId))
      .orderBy(schema.subscriptions.createdAt)
      .limit(1),
  ]);

  const used: Partial<Record<Quota, number>> = {};
  for (const row of counterRows) {
    used[row.metric as Quota] = Number(row.value);
  }

  const planDef =
    DEFAULT_PLANS.find((p) => p.code === ctx.plan.code) ?? DEFAULT_PLANS[0]!;
  const sub = subRows[0] ?? null;
  const renewalDate = sub?.currentPeriodEnd ?? end;
  const daysLeft = daysUntil(renewalDate);

  const rows: QuotaRow[] = SHOWN_QUOTAS.map((q) => ({
    metric: q.metric,
    label: q.label,
    description: q.description,
    used: used[q.metric] ?? 0,
    cap: planDef.quotas[q.metric] ?? 0,
  }));

  return (
    <section className="surface p-6 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-mid">
            Current plan
          </div>
          <div className="flex items-baseline gap-2">
            <h2 className="text-[22px] font-semibold text-ink">
              {planDef.name}
            </h2>
            {planDef.priceMonthlyUsdCents != null &&
              planDef.priceMonthlyUsdCents > 0 && (
                <span className="text-sm text-mid">
                  ${(planDef.priceMonthlyUsdCents / 100).toFixed(0)}/mo
                </span>
              )}
            {planDef.priceMonthlyUsdCents === 0 && (
              <span className="text-sm text-mid">Free</span>
            )}
          </div>
          <p className="text-sm text-mid max-w-md">{planDef.description}</p>
        </div>
        <div className="text-right space-y-0.5">
          <div className="text-[11px] uppercase tracking-wider text-mid">
            Renews
          </div>
          <div className="text-sm text-ink">{formatDate(renewalDate)}</div>
          <div className="text-xs text-faint">
            in {daysLeft} day{daysLeft === 1 ? "" : "s"}
          </div>
        </div>
      </header>

      <div className="space-y-4">
        {rows.map((row) => (
          <QuotaBar key={row.metric} row={row} />
        ))}
      </div>

      {planDef.code === "free" && (
        <div className="surface-2 px-4 py-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-ink">
              Need more headroom?
            </div>
            <div className="text-xs text-mid">
              Higher plans unlock the asset pipeline, research, and bigger
              quotas.
            </div>
          </div>
          <a href="/settings/plans" className="btn btn-primary">
            View plans
          </a>
        </div>
      )}
    </section>
  );
}

function QuotaBar({ row }: { row: QuotaRow }) {
  const unlimited = row.cap === -1;
  const fraction = unlimited ? 0 : row.cap > 0 ? row.used / row.cap : 0;
  const pct = Math.min(100, Math.round(fraction * 100));
  const tone =
    unlimited
      ? "ok"
      : fraction >= 1
        ? "danger"
        : fraction >= 0.85
          ? "warn"
          : "ok";

  const barColor =
    tone === "danger"
      ? "bg-danger"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-accent";

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <div>
          <div className="text-sm font-medium text-ink">{row.label}</div>
          <div className="text-[11px] text-faint">{row.description}</div>
        </div>
        <div className="text-sm tabular-nums text-ink">
          {formatNumber(row.used)}{" "}
          <span className="text-faint">
            / {unlimited ? "∞" : formatNumber(row.cap)}
          </span>
        </div>
      </div>
      <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
        <div
          className={`h-full ${barColor} transition-[width] duration-500`}
          style={{ width: unlimited ? "100%" : `${pct}%` }}
        />
      </div>
    </div>
  );
}
