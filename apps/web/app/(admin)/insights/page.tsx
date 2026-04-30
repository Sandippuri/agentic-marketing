/**
 * /insights — "What's working" dashboard.
 * Top performers per channel, sortable by CTR / engagement / impressions / clicks.
 * Phase 11 Day 4.
 */

import Link from "next/link";
import { desc, eq, and, sql } from "drizzle-orm";
import { getDb, schema, outcomes } from "@marketing/db";
import { CHANNELS } from "@marketing/shared-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WINDOWS = ["7d", "30d", "90d"] as const;
const SORT_OPTIONS = ["ctr", "engagement", "impressions", "clicks"] as const;

const CHANNEL_LABEL: Record<string, string> = {
  internal_blog: "Blog",
  linkedin: "LinkedIn",
  x: "X / Twitter",
  hubspot_email: "HubSpot Email",
  mailchimp: "Mailchimp",
};

const STAGE_CHIP: Record<string, string> = {
  pull: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  explain: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  reinforce: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  push: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
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

  // Summary stats card: median CTR per channel for the selected window.
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
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            Insights
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Top-performing content — grounding signal for the AI.
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap justify-end">
          {/* Window filter */}
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm">
            {WINDOWS.map((w) => (
              <Link
                key={w}
                href={buildUrl({ window: w })}
                className={`px-3 py-1.5 transition-colors ${
                  windowParam === w
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-medium"
                    : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                {w}
              </Link>
            ))}
          </div>

          {/* Sort filter */}
          <select
            // Server form navigation isn't available here, so we render as a plain link set.
            name="sortBy"
            className="text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-1.5 text-zinc-700 dark:text-zinc-300 focus:outline-none"
            defaultValue={sortBy}
            // We use a link approach — the select here is just visual; JS is needed for interaction.
            // For full SSR interaction, users can use the URL params directly.
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s} value={s}>
                Sort: {s}
              </option>
            ))}
          </select>

          {/* Channel filter */}
          <div className="flex items-center gap-1 flex-wrap">
            <Link
              href={buildUrl({ channel: "" })}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                !channelParam
                  ? "bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100"
                  : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400"
              }`}
            >
              All
            </Link>
            {CHANNELS.map((ch) => (
              <Link
                key={ch}
                href={buildUrl({ channel: ch })}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  channelParam === ch
                    ? "bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100"
                    : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400"
                }`}
              >
                {CHANNEL_LABEL[ch] ?? ch}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Channel summary cards */}
      {summaryRows.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {summaryRows.map((s) => (
            <div
              key={String(s.channel)}
              className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-1"
            >
              <div className="text-xs text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wider">
                {CHANNEL_LABEL[s.channel ?? ""] ?? s.channel}
              </div>
              <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
                {(parseFloat(s.avgCtr ?? "0") * 100).toFixed(2)}
                <span className="text-sm font-normal text-zinc-400 ml-0.5">%</span>
              </div>
              <div className="text-xs text-zinc-500">
                avg CTR · {s.totalPosts} posts
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Top performers table */}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-12 text-center">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No outcome data yet for the selected filters.
          </p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-600">
            Outcomes are rolled up nightly after metrics are collected.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
                <th className="px-4 py-2.5 text-left font-medium text-zinc-500 dark:text-zinc-400 w-8">
                  #
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  Title
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  Channel
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  Stage
                </th>
                <th className="px-4 py-2.5 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  Impressions
                </th>
                <th className="px-4 py-2.5 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  Clicks
                </th>
                <th className="px-4 py-2.5 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  <Link
                    href={buildUrl({ sortBy: "ctr" })}
                    className={`hover:text-zinc-900 dark:hover:text-zinc-100 ${sortBy === "ctr" ? "text-zinc-900 dark:text-zinc-100 font-semibold" : ""}`}
                  >
                    CTR ↓
                  </Link>
                </th>
                <th className="px-4 py-2.5 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  <Link
                    href={buildUrl({ sortBy: "engagement" })}
                    className={`hover:text-zinc-900 dark:hover:text-zinc-100 ${sortBy === "engagement" ? "text-zinc-900 dark:text-zinc-100 font-semibold" : ""}`}
                  >
                    Eng. ↓
                  </Link>
                </th>
                <th className="px-4 py-2.5 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  Conv.
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((row, i) => (
                <tr
                  key={`${row.contentId}-${row.channel}`}
                  className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
                >
                  <td className="px-4 py-3 text-zinc-400 text-xs tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100 max-w-xs">
                    {row.publishedUrl ? (
                      <a
                        href={row.publishedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline line-clamp-2"
                      >
                        {row.title}
                      </a>
                    ) : (
                      <span className="line-clamp-2">{row.title}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 whitespace-nowrap text-xs">
                    {CHANNEL_LABEL[row.channel ?? ""] ?? row.channel}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        STAGE_CHIP[row.stage] ?? "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {row.stage}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {row.impressions?.toLocaleString() ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {row.clicks?.toLocaleString() ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                    {(parseFloat(row.ctr) * 100).toFixed(2)}%
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {(parseFloat(row.engagementRate) * 100).toFixed(2)}%
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {row.conversions?.toLocaleString() ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-zinc-400 dark:text-zinc-600">
        Outcomes are pre-rolled nightly. Values reflect the {windowParam} window.
        Human-approved playbook updates based on this data are a manual step — see{" "}
        <code className="font-mono">apps/manager/memory/playbooks/</code>.
      </p>
    </div>
  );
}
