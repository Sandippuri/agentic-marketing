import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb, schema } from "@marketing/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  in_review: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  published: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  retracted: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const STAGE_DOT: Record<string, string> = {
  pull: "bg-sky-500",
  explain: "bg-violet-500",
  reinforce: "bg-amber-500",
  push: "bg-emerald-500",
};

const PHASE_BADGE: Record<string, string> = {
  buildup: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  launch: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  post_launch: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

export default async function CampaignDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, id))
    .limit(1);
  if (!campaign) notFound();

  const [items, statusSummary] = await Promise.all([
    db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.campaignId, id))
      .orderBy(desc(schema.contentItems.createdAt)),
    db
      .select({
        status: schema.contentItems.status,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.campaignId, id))
      .groupBy(schema.contentItems.status),
  ]);

  const statusCounts = Object.fromEntries(
    statusSummary.map((r) => [r.status, r.count]),
  );

  const calendarItems = Array.isArray(campaign.calendarJson)
    ? (campaign.calendarJson as Array<{
        title: string;
        type: string;
        stage: string;
        phase: string;
        scheduledFor?: string;
      }>)
    : [];

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/campaigns" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
              ← Campaigns
            </Link>
          </div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {campaign.name}
          </h1>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs text-zinc-500 font-mono">{campaign.slug}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                PHASE_BADGE[campaign.phase] ?? "bg-zinc-100 text-zinc-600"
              }`}
            >
              {campaign.phase.replace("_", " ")}
            </span>
            <span className="text-xs text-zinc-400">{campaign.status}</span>
          </div>
        </div>

        {/* Status summary pills */}
        <div className="flex gap-2 flex-wrap justify-end">
          {Object.entries(statusCounts).map(([status, count]) => (
            <span
              key={status}
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                STATUS_BADGE[status] ?? "bg-zinc-100 text-zinc-600"
              }`}
            >
              {count} {status.replace("_", " ")}
            </span>
          ))}
        </div>
      </div>

      {/* Brief */}
      {campaign.briefMd && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
            Brief
          </h2>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
            <pre className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed font-sans">
              {campaign.briefMd}
            </pre>
          </div>
        </section>
      )}

      {/* Calendar */}
      {calendarItems.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
            Content Calendar ({calendarItems.length} items)
          </h2>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Title</th>
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Type</th>
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Stage</th>
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Phase</th>
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Scheduled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {calendarItems.map((item, i) => (
                  <tr key={i} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <td className="px-4 py-2.5 text-zinc-900 dark:text-zinc-100 max-w-xs truncate">
                      {item.title}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs">{item.type}</td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${STAGE_DOT[item.stage] ?? "bg-zinc-400"}`}
                        />
                        {item.stage}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs">
                      {item.phase.replace("_", " ")}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs">
                      {item.scheduledFor
                        ? new Date(item.scheduledFor).toLocaleDateString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Content items */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
            Content Items ({items.length})
          </h2>
          <Link
            href={`/approvals`}
            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            View pending approvals →
          </Link>
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No content items yet. Ask the agent to draft some via chat.
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Title</th>
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Type</th>
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Stage</th>
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-zinc-500">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {items.map((it) => (
                  <tr
                    key={it.id}
                    className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
                  >
                    <td className="px-4 py-2.5 text-zinc-900 dark:text-zinc-100 max-w-xs">
                      <span className="truncate block">{it.title}</span>
                      {it.publishedUrl && (
                        <a
                          href={it.publishedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline truncate block mt-0.5"
                        >
                          {it.publishedUrl}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">
                      {it.type}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${STAGE_DOT[it.stage] ?? "bg-zinc-400"}`}
                        />
                        {it.stage}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          STATUS_BADGE[it.status] ?? "bg-zinc-100 text-zinc-600"
                        }`}
                      >
                        {it.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">
                      {new Date(it.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
