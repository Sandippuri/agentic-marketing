import { desc, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const STATUS_BADGE: Record<string, string> = {
  queued:    "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  running:   "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  succeeded: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed:    "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  cancelled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

export default async function PublishJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  // Filter by channel / status if provided.
  const conditions = [];
  if (params.channel) conditions.push(eq(schema.publishJobs.channel, params.channel as never));
  if (params.status) conditions.push(eq(schema.publishJobs.status, params.status as never));

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: schema.publishJobs.id,
        contentId: schema.publishJobs.contentId,
        channel: schema.publishJobs.channel,
        status: schema.publishJobs.status,
        externalUrl: schema.publishJobs.externalUrl,
        error: schema.publishJobs.error,
        attempts: schema.publishJobs.attempts,
        scheduledAt: schema.publishJobs.scheduledAt,
        createdAt: schema.publishJobs.createdAt,
        updatedAt: schema.publishJobs.updatedAt,
        contentTitle: schema.contentItems.title,
        campaignName: schema.campaigns.name,
      })
      .from(schema.publishJobs)
      .leftJoin(schema.contentItems, eq(schema.publishJobs.contentId, schema.contentItems.id))
      .leftJoin(schema.campaigns, eq(schema.contentItems.campaignId, schema.campaigns.id))
      .where(conditions.length ? conditions.reduce((a, b) => sql`${a} AND ${b}`) : undefined)
      .orderBy(desc(schema.publishJobs.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.publishJobs)
      .where(conditions.length ? conditions.reduce((a, b) => sql`${a} AND ${b}`) : undefined),
  ]);

  // Today's counts per channel.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCounts = await db
    .select({ channel: schema.publishJobs.channel, count: sql<number>`count(*)::int` })
    .from(schema.publishJobs)
    .where(
      sql`${schema.publishJobs.status} = 'succeeded' AND ${schema.publishJobs.createdAt} >= ${todayStart}`,
    )
    .groupBy(schema.publishJobs.channel);

  const total = countResult[0]?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-semibold">Publish Jobs</h1>
        <span className="text-sm text-zinc-500">{total} total</span>
      </div>

      {/* Today's channel counts */}
      {todayCounts.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-3">
          {todayCounts.map((c) => (
            <div
              key={c.channel}
              className="flex items-center gap-2 rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1 text-xs font-medium"
            >
              <span className="text-zinc-500">today</span>
              <span className="font-semibold">{c.channel}</span>
              <span className="text-emerald-600 dark:text-emerald-400">{c.count}</span>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className="text-left px-4 py-3">Content</th>
              <th className="text-left px-4 py-3">Channel</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Scheduled</th>
              <th className="text-left px-4 py-3">Updated</th>
              <th className="text-left px-4 py-3">Link / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((job) => (
              <tr key={job.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium max-w-xs truncate">{job.contentTitle ?? job.contentId.slice(0, 8)}</div>
                  {job.campaignName && (
                    <div className="text-xs text-zinc-400 truncate">{job.campaignName}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{job.channel}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[job.status] ?? ""}`}>
                    {job.status}
                    {(job.attempts ?? 0) > 1 && (
                      <span className="ml-1 opacity-60">×{job.attempts}</span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-zinc-500">
                  {job.scheduledAt
                    ? new Date(job.scheduledAt).toLocaleString()
                    : "immediate"}
                </td>
                <td className="px-4 py-3 text-xs text-zinc-500">
                  {new Date(job.updatedAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-xs max-w-xs">
                  {job.externalUrl ? (
                    <a
                      href={job.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 dark:text-indigo-400 hover:underline truncate block"
                    >
                      {job.externalUrl}
                    </a>
                  ) : job.error ? (
                    <span className="text-red-600 dark:text-red-400 truncate block" title={job.error}>
                      {job.error.slice(0, 80)}
                    </span>
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-zinc-500">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            {page > 1 && (
              <a
                href={`?page=${page - 1}${params.channel ? `&channel=${params.channel}` : ""}${params.status ? `&status=${params.status}` : ""}`}
                className="rounded border border-zinc-200 dark:border-zinc-700 px-3 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                ← Prev
              </a>
            )}
            {page < totalPages && (
              <a
                href={`?page=${page + 1}${params.channel ? `&channel=${params.channel}` : ""}${params.status ? `&status=${params.status}` : ""}`}
                className="rounded border border-zinc-200 dark:border-zinc-700 px-3 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                Next →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
