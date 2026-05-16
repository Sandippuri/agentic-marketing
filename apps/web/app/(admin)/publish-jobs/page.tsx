import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getWorkspaceContext } from "@/lib/billing";
import { PageHeader, Badge, EmptyState, statusTone } from "../ui";
import { PublishJobFilters } from "./filters";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function PublishJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();
  const ctx = await getWorkspaceContext();
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const conditions = [eq(schema.publishJobs.workspaceId, ctx.workspaceId)];
  if (params.channel) conditions.push(eq(schema.publishJobs.channel, params.channel as never));
  if (params.status) conditions.push(eq(schema.publishJobs.status, params.status as never));

  const where = and(...conditions);

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
      .where(where)
      .orderBy(desc(schema.publishJobs.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.publishJobs)
      .where(where),
  ]);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCounts = await db
    .select({ channel: schema.publishJobs.channel, count: sql<number>`count(*)::int` })
    .from(schema.publishJobs)
    .where(
      and(
        eq(schema.publishJobs.workspaceId, ctx.workspaceId),
        eq(schema.publishJobs.status, "succeeded"),
        gte(schema.publishJobs.createdAt, todayStart),
      ),
    )
    .groupBy(schema.publishJobs.channel);

  const total = countResult[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Channels & statuses are inferred from the rows for the filter dropdowns.
  const channels = ["internal_blog", "linkedin", "x", "email_hubspot", "email_mailchimp"];
  const statuses = ["queued", "running", "succeeded", "failed", "cancelled"];

  const pageUrl = (n: number) => {
    const p = new URLSearchParams({
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.status ? { status: params.status } : {}),
      page: String(n),
    });
    return `?${p.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="Publish jobs"
        description="Outbound posts the publisher has queued, attempted, or completed."
        meta={
          <>
            <Badge tone="neutral">{total} total</Badge>
            {todayCounts.length > 0 && (
              <Badge tone="success" dot>
                {todayCounts.reduce((s, c) => s + c.count, 0)} published today
              </Badge>
            )}
          </>
        }
      />

      {/* Today by channel */}
      {todayCounts.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
          {todayCounts.map((c) => (
            <div key={c.channel} className="surface px-4 py-3">
              <div className="section-title">{prettyChannel(c.channel)}</div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="text-xl font-semibold tabular-nums text-ink">
                  {c.count}
                </span>
                <span className="text-[11px] text-faint">today</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <PublishJobFilters
        channel={params.channel ?? ""}
        status={params.status ?? ""}
        channels={channels}
        statuses={statuses}
      />

      {/* Table */}
      {rows.length === 0 ? (
        <EmptyState
          title="No publish jobs"
          description="Queued and completed publishes will show up here."
        />
      ) : (
        <div className="table-card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Content</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Scheduled</th>
                <th>Updated</th>
                <th>Link / error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((job) => (
                <tr key={job.id}>
                  <td>
                    <div className="font-medium text-ink max-w-xs truncate">
                      {job.contentTitle ?? job.contentId.slice(0, 8)}
                    </div>
                    {job.campaignName && (
                      <div className="text-xs text-faint truncate">{job.campaignName}</div>
                    )}
                  </td>
                  <td className="text-mid">{prettyChannel(job.channel)}</td>
                  <td>
                    <Badge tone={statusTone(job.status)} dot>
                      {job.status}
                      {(job.attempts ?? 0) > 1 && (
                        <span className="opacity-60 ml-1">×{job.attempts}</span>
                      )}
                    </Badge>
                  </td>
                  <td className="text-xs text-mid mono whitespace-nowrap">
                    {job.scheduledAt
                      ? new Date(job.scheduledAt).toLocaleString()
                      : "immediate"}
                  </td>
                  <td className="text-xs text-mid mono whitespace-nowrap">
                    {new Date(job.updatedAt).toLocaleString()}
                  </td>
                  <td className="text-xs max-w-xs">
                    {job.externalUrl ? (
                      <a
                        href={job.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--accent)] hover:underline truncate block"
                      >
                        {job.externalUrl}
                      </a>
                    ) : job.error ? (
                      <span
                        className="text-[var(--danger)] truncate block"
                        title={job.error}
                      >
                        {job.error.slice(0, 80)}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-mid">
            Page <span className="text-ink font-medium">{page}</span> of {totalPages}
          </span>
          <div className="flex gap-2">
            <a
              href={pageUrl(Math.max(1, page - 1))}
              className={`btn btn-secondary btn-sm ${page <= 1 ? "pointer-events-none opacity-50" : ""}`}
            >
              ← Previous
            </a>
            <a
              href={pageUrl(Math.min(totalPages, page + 1))}
              className={`btn btn-secondary btn-sm ${page >= totalPages ? "pointer-events-none opacity-50" : ""}`}
            >
              Next →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function prettyChannel(c: string) {
  return c.replace(/_/g, " ");
}
