/**
 * /insights — "What's working" dashboard.
 * Top performers per channel, sortable by CTR / engagement / impressions / clicks.
 */

import Link from "next/link";
import { desc, eq, and, sql } from "drizzle-orm";
import { getDb, schema, outcomes } from "@marketing/db";
import { CHANNELS } from "@marketing/shared-types";
import { PageHeader, Badge, EmptyState } from "../ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WINDOWS = ["7d", "30d", "90d"] as const;
const SORT_OPTIONS = ["ctr", "engagement", "impressions", "clicks"] as const;

const CHANNEL_LABEL: Record<(typeof CHANNELS)[number], string> = {
  internal_blog: "Blog",
  linkedin: "LinkedIn",
  x: "X",
  email_hubspot: "HubSpot",
  email_mailchimp: "Mailchimp",
};

const STAGE_TONE: Record<string, "info" | "violet" | "warn" | "success"> = {
  pull: "info",
  explain: "violet",
  reinforce: "warn",
  push: "success",
};

type SortBy = (typeof SORT_OPTIONS)[number];
type Window = (typeof WINDOWS)[number];

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{
    channel?: string;
    window?: string;
    sortBy?: string;
    limit?: string;
  }>;
}) {
  const params = await searchParams;
  const windowParam = (WINDOWS.includes(params.window as Window) ? params.window : "30d") as Window;
  const sortBy = (SORT_OPTIONS.includes(params.sortBy as SortBy) ? params.sortBy : "ctr") as SortBy;
  const limitParam = Math.min(50, Math.max(5, Number(params.limit ?? 10)));
  const channelParam = CHANNELS.includes(params.channel as (typeof CHANNELS)[number])
    ? (params.channel as (typeof CHANNELS)[number])
    : undefined;

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
    .innerJoin(schema.contentItems, eq(outcomes.contentId, schema.contentItems.id))
    .where(
      and(
        eq(outcomes.window, windowParam),
        channelParam ? eq(outcomes.channel, channelParam) : sql`true`,
      ),
    )
    .orderBy(desc(sortCol))
    .limit(limitParam);

  const summaryRows = await db
    .select({
      channel: outcomes.channel,
      avgCtr: sql<string>`avg(${outcomes.ctr})`,
      avgEngagement: sql<string>`avg(${outcomes.engagementRate})`,
      totalPosts: sql<number>`count(*)::int`,
    })
    .from(outcomes)
    .where(eq(outcomes.window, windowParam))
    .groupBy(outcomes.channel)
    .orderBy(sql`avg(${outcomes.ctr}) desc`);

  const buildUrl = (overrides: Record<string, string>) => {
    const p = new URLSearchParams({
      window: windowParam,
      sortBy,
      limit: String(limitParam),
      ...(channelParam ? { channel: channelParam } : {}),
      ...overrides,
    });
    return `/insights?${p.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="Insights"
        description="What's working — top-performing content used as grounding signal for the agent."
        meta={
          <Badge tone="info">
            Window: {windowParam}
          </Badge>
        }
      />

      {/* Toolbar */}
      <div className="surface mb-5 px-3 py-2.5 flex flex-wrap items-center gap-3">
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1">Window</span>
        <Segmented
          options={WINDOWS.map((w) => ({ value: w, label: w }))}
          current={windowParam}
          buildUrl={(v) => buildUrl({ window: v })}
        />
        <span className="h-5 w-px bg-[var(--border)] mx-1" />
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1">Sort</span>
        <Segmented
          options={SORT_OPTIONS.map((s) => ({
            value: s,
            label: s === "ctr" ? "CTR" : s === "engagement" ? "Eng." : s,
          }))}
          current={sortBy}
          buildUrl={(v) => buildUrl({ sortBy: v })}
        />
        <span className="h-5 w-px bg-[var(--border)] mx-1" />
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1">Channel</span>
        <Segmented
          options={[
            { value: "", label: "All" },
            ...CHANNELS.map((ch) => ({ value: ch, label: CHANNEL_LABEL[ch] ?? ch })),
          ]}
          current={channelParam ?? ""}
          buildUrl={(v) => buildUrl({ channel: v })}
        />
      </div>

      {/* Channel summary cards */}
      {summaryRows.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 mb-6">
          {summaryRows.map((s) => (
            <div key={String(s.channel)} className="surface p-4">
              <div className="section-title">
                {CHANNEL_LABEL[s.channel ?? ""] ?? s.channel}
              </div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold text-ink tabular-nums">
                  {(parseFloat(s.avgCtr ?? "0") * 100).toFixed(2)}
                </span>
                <span className="text-sm text-faint">%</span>
              </div>
              <div className="mt-1 text-[11px] text-mid">
                avg CTR · <span className="tabular-nums">{s.totalPosts}</span> posts
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Top performers table */}
      {rows.length === 0 ? (
        <EmptyState
          title="No outcome data yet"
          description="Outcomes are rolled up nightly after metrics are collected. Try widening the window or removing the channel filter."
        />
      ) : (
        <div className="table-card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="w-10 text-right">#</th>
                <th>Title</th>
                <th>Channel</th>
                <th>Stage</th>
                <th className="text-right">Impressions</th>
                <th className="text-right">Clicks</th>
                <th className={`text-right ${sortBy === "ctr" ? "!text-ink" : ""}`}>
                  CTR{sortBy === "ctr" ? " ↓" : ""}
                </th>
                <th className={`text-right ${sortBy === "engagement" ? "!text-ink" : ""}`}>
                  Eng.{sortBy === "engagement" ? " ↓" : ""}
                </th>
                <th className="text-right">Conv.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.contentId}-${row.channel}`}>
                  <td className="text-faint text-xs tabular-nums text-right">
                    {i + 1}
                  </td>
                  <td className="max-w-xs">
                    {row.publishedUrl ? (
                      <a
                        href={row.publishedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ink hover:text-[var(--accent)] hover:underline line-clamp-2 transition-colors"
                      >
                        {row.title}
                      </a>
                    ) : (
                      <span className="text-ink line-clamp-2">{row.title}</span>
                    )}
                  </td>
                  <td className="text-mid whitespace-nowrap text-xs">
                    {CHANNEL_LABEL[row.channel ?? ""] ?? row.channel}
                  </td>
                  <td>
                    <Badge tone={STAGE_TONE[row.stage] ?? "neutral"}>
                      {row.stage}
                    </Badge>
                  </td>
                  <td className="text-right tabular-nums text-mid">
                    {row.impressions?.toLocaleString() ?? "—"}
                  </td>
                  <td className="text-right tabular-nums text-mid">
                    {row.clicks?.toLocaleString() ?? "—"}
                  </td>
                  <td className="text-right tabular-nums font-medium text-ink">
                    {(parseFloat(row.ctr) * 100).toFixed(2)}%
                  </td>
                  <td className="text-right tabular-nums text-mid">
                    {(parseFloat(row.engagementRate) * 100).toFixed(2)}%
                  </td>
                  <td className="text-right tabular-nums text-mid">
                    {row.conversions?.toLocaleString() ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-faint">
        Outcomes pre-rolled nightly. Values reflect the {windowParam} window. Playbook updates from
        this data are a manual step — see <code className="mono">apps/manager/memory/playbooks/</code>.
      </p>
    </div>
  );
}

function Segmented({
  options,
  current,
  buildUrl,
}: {
  options: { value: string; label: string }[];
  current: string;
  buildUrl: (v: string) => string;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
      {options.map((opt) => {
        const active = current === opt.value;
        return (
          <Link
            key={opt.value || "_all"}
            href={buildUrl(opt.value)}
            className={[
              "px-2.5 py-1 text-[12px] rounded transition-colors capitalize",
              active
                ? "bg-[var(--bg-elevated)] text-ink shadow-sm"
                : "text-mid hover:text-ink",
            ].join(" ")}
          >
            {opt.label}
          </Link>
        );
      })}
    </div>
  );
}
