import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CAMPAIGN_PHASES, CAMPAIGN_STATUSES } from "@marketing/shared-types";
import { NewCampaignForm } from "./new-campaign-form";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PHASE_BADGE: Record<string, string> = {
  buildup:     "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  launch:      "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  post_launch: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

const STATUS_COLOR: Record<string, string> = {
  active:    "text-emerald-600 dark:text-emerald-400",
  draft:     "text-zinc-500 dark:text-zinc-400",
  paused:    "text-amber-600 dark:text-amber-400",
  completed: "text-blue-600 dark:text-blue-400",
  archived:  "text-zinc-400 dark:text-zinc-600",
};

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; phase?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();

  const conditions = [];
  if (params.status && CAMPAIGN_STATUSES.includes(params.status as (typeof CAMPAIGN_STATUSES)[number])) {
    conditions.push(eq(schema.campaigns.status, params.status as (typeof CAMPAIGN_STATUSES)[number]));
  }
  if (params.phase && CAMPAIGN_PHASES.includes(params.phase as (typeof CAMPAIGN_PHASES)[number])) {
    conditions.push(eq(schema.campaigns.phase, params.phase as (typeof CAMPAIGN_PHASES)[number]));
  }

  const [campaigns, contentCounts] = await Promise.all([
    db
      .select()
      .from(schema.campaigns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.campaigns.createdAt)),
    db
      .select({
        campaignId: schema.contentItems.campaignId,
        total: sql<number>`count(*)::int`,
        approved: sql<number>`count(*) filter (where ${schema.contentItems.status} = 'approved')::int`,
        published: sql<number>`count(*) filter (where ${schema.contentItems.status} = 'published')::int`,
      })
      .from(schema.contentItems)
      .groupBy(schema.contentItems.campaignId),
  ]);

  const countsByCampaign = Object.fromEntries(
    contentCounts.map((r) => [r.campaignId, r]),
  );

  const buildUrl = (overrides: Record<string, string>) => {
    const p = new URLSearchParams({
      ...(params.status ? { status: params.status } : {}),
      ...(params.phase ? { phase: params.phase } : {}),
      ...overrides,
    });
    const str = p.toString();
    return `/campaigns${str ? `?${str}` : ""}`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Campaigns</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}
            {params.status || params.phase ? " (filtered)" : ""}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Status filter */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm">
          <Link
            href={buildUrl({ status: "" })}
            className={`px-3 py-1.5 transition-colors ${
              !params.status
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-medium"
                : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            All
          </Link>
          {CAMPAIGN_STATUSES.map((s) => (
            <Link
              key={s}
              href={buildUrl({ status: s })}
              className={`px-3 py-1.5 transition-colors capitalize ${
                params.status === s
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-medium"
                  : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {s}
            </Link>
          ))}
        </div>

        {/* Phase filter */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm">
          <Link
            href={buildUrl({ phase: "" })}
            className={`px-3 py-1.5 transition-colors ${
              !params.phase
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-medium"
                : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            All phases
          </Link>
          {CAMPAIGN_PHASES.map((ph) => (
            <Link
              key={ph}
              href={buildUrl({ phase: ph })}
              className={`px-3 py-1.5 transition-colors capitalize ${
                params.phase === ph
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-medium"
                  : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {ph.replace("_", " ")}
            </Link>
          ))}
        </div>
      </div>

      {/* Campaign list */}
      {campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
          No campaigns yet. Create one below or via{" "}
          <code className="font-mono">@marketing plan a campaign</code> in Slack.
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
                <th className="px-4 py-2.5 text-left font-medium text-zinc-500">Name</th>
                <th className="px-4 py-2.5 text-left font-medium text-zinc-500">Phase</th>
                <th className="px-4 py-2.5 text-left font-medium text-zinc-500">Status</th>
                <th className="px-4 py-2.5 text-right font-medium text-zinc-500">Content</th>
                <th className="px-4 py-2.5 text-right font-medium text-zinc-500">Published</th>
                <th className="px-4 py-2.5 text-left font-medium text-zinc-500">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {campaigns.map((c) => {
                const counts = countsByCampaign[c.id];
                return (
                  <tr key={c.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        href={`/campaigns/${c.id}`}
                        className="font-medium text-zinc-900 dark:text-zinc-100 hover:text-indigo-600 dark:hover:text-indigo-400"
                      >
                        {c.name}
                      </Link>
                      <p className="text-xs text-zinc-400 font-mono mt-0.5">{c.slug}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          PHASE_BADGE[c.phase] ?? "bg-zinc-100 text-zinc-600"
                        }`}
                      >
                        {c.phase.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium capitalize ${STATUS_COLOR[c.status] ?? "text-zinc-500"}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                      {counts ? (
                        <span>
                          {counts.total}
                          {counts.approved > 0 && (
                            <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                              ({counts.approved} approved)
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                      {counts?.published ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-xs whitespace-nowrap">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* New campaign form */}
      <div className="pt-2">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
          New campaign
        </h2>
        <NewCampaignForm />
      </div>
    </div>
  );
}
