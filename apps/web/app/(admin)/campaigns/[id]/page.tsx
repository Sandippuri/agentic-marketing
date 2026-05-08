import Link from "next/link";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb, schema } from "@marketing/db";
import { DraftCalendarItemButton } from "./draft-button";
import { RedraftButton } from "./redraft-button";
import { CampaignChat } from "./campaign-chat";
import { CampaignTabs } from "./campaign-tabs";
import { PageHeader, Badge, EmptyState, Card, CardHeader, statusTone } from "../../ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const STAGE_DOT: Record<string, string> = {
  pull: "bg-sky-500",
  explain: "bg-violet-500",
  reinforce: "bg-amber-500",
  push: "bg-emerald-500",
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

  // Items whose latest review decision was changes_requested / rejected
  // get a Redraft button. Status alone can't tell these apart from
  // never-reviewed drafts, so we look at the approvals table.
  const itemIds = items.map((it) => it.id);
  const reviseable = new Set<string>();
  if (itemIds.length > 0) {
    const decisions = await db
      .select({
        contentId: schema.approvals.contentId,
        decision: schema.approvals.decision,
      })
      .from(schema.approvals)
      .where(inArray(schema.approvals.contentId, itemIds));
    for (const d of decisions) {
      if (d.decision === "changes_requested" || d.decision === "rejected") {
        reviseable.add(d.contentId);
      }
    }
  }

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

  const phaseTone =
    campaign.phase === "buildup"
      ? "info"
      : campaign.phase === "launch"
        ? "warn"
        : "violet";

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] xl:gap-8">
      <div className="min-w-0">
      {/* Breadcrumb */}
      <div className="mb-3">
        <Link
          href="/campaigns"
          className="inline-flex items-center gap-1 text-xs text-mid hover:text-ink transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Campaigns
        </Link>
      </div>

      <PageHeader
        title={campaign.name}
        meta={
          <>
            <span className="mono text-xs text-faint">{campaign.slug}</span>
            <Badge tone={phaseTone}>{campaign.phase.replace("_", " ")}</Badge>
            <Badge tone={statusTone(campaign.status)} dot>
              {campaign.status}
            </Badge>
          </>
        }
        actions={
          <Link href="/approvals" className="btn btn-secondary btn-sm">
            View pending approvals
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Link>
        }
      />

      {/* Status summary stats */}
      {Object.keys(statusCounts).length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {Object.entries(statusCounts).map(([status, count]) => (
            <Badge key={status} tone={statusTone(status)} dot>
              {count} {status.replace("_", " ")}
            </Badge>
          ))}
        </div>
      )}

      <CampaignTabs
        hasBrief={Boolean(campaign.briefMd)}
        calendarCount={calendarItems.length}
        contentCount={items.length}
        brief={
          campaign.briefMd ? (
            <Card padded={false}>
              <div className="px-5 pt-4 pb-2">
                <CardHeader title="Brief" description="Strategist output and campaign objective." />
              </div>
              <div className="border-t border-[var(--border)] px-5 py-4 bg-[var(--surface-2)]">
                <pre className="text-sm text-mid whitespace-pre-wrap leading-relaxed font-sans">
                  {campaign.briefMd}
                </pre>
              </div>
            </Card>
          ) : (
            <EmptyState
              title="No brief yet"
              description="The strategist hasn't produced a brief for this campaign."
            />
          )
        }
        calendar={
          calendarItems.length > 0 ? (
            <div className="table-card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Stage</th>
                    <th>Phase</th>
                    <th>Scheduled</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {calendarItems.map((item, i) => (
                    <tr key={i}>
                      <td className="font-medium text-ink max-w-xs truncate">{item.title}</td>
                      <td className="text-mid text-xs">{item.type}</td>
                      <td>
                        <span className="inline-flex items-center gap-1.5 text-xs text-mid">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${STAGE_DOT[item.stage] ?? "bg-zinc-400"}`}
                          />
                          {item.stage}
                        </span>
                      </td>
                      <td className="text-mid text-xs capitalize">
                        {item.phase.replace("_", " ")}
                      </td>
                      <td className="text-mid text-xs mono">
                        {item.scheduledFor
                          ? new Date(item.scheduledFor).toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="text-right">
                        <DraftCalendarItemButton
                          campaignId={campaign.id}
                          itemTitle={item.title}
                          itemType={item.type}
                          itemStage={item.stage}
                          briefSnippet={(campaign.briefMd ?? "").slice(0, 1500)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No calendar items"
              description="The strategist hasn't planned any calendar items yet."
            />
          )
        }
        content={
          items.length === 0 ? (
            <EmptyState
              title="No content items yet"
              description="Ask the agent to draft items via campaign chat."
            />
          ) : (
            <div className="table-card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Stage</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id}>
                      <td className="max-w-xs">
                        <Link
                          href={`/campaigns/${campaign.id}/content/${it.id}`}
                          className="font-medium text-ink hover:text-[var(--accent)] truncate block transition-colors"
                        >
                          {it.title}
                        </Link>
                        {it.publishedUrl && (
                          <a
                            href={it.publishedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[var(--accent)] hover:underline truncate block mt-0.5"
                          >
                            {it.publishedUrl}
                          </a>
                        )}
                      </td>
                      <td className="text-mid text-xs whitespace-nowrap">{it.type}</td>
                      <td>
                        <span className="inline-flex items-center gap-1.5 text-xs text-mid">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${STAGE_DOT[it.stage] ?? "bg-zinc-400"}`}
                          />
                          {it.stage}
                        </span>
                      </td>
                      <td>
                        <Badge tone={statusTone(it.status)} dot>
                          {it.status.replace("_", " ")}
                        </Badge>
                      </td>
                      <td className="text-mid text-xs mono whitespace-nowrap">
                        {new Date(it.createdAt).toLocaleDateString()}
                      </td>
                      <td className="text-right">
                        {reviseable.has(it.id) && it.status === "draft" ? (
                          <RedraftButton
                            campaignId={campaign.id}
                            contentId={it.id}
                            itemTitle={it.title}
                            itemType={it.type}
                          />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      />
      </div>

      {/* Campaign-scoped chat — sticky on the right, full-height column */}
      <aside className="hidden xl:block">
        <div className="sticky top-7 h-[calc(100dvh-3.5rem)] flex flex-col">
          <h2 className="section-title mb-3">Campaign chat</h2>
          <div className="flex-1 min-h-0">
            <CampaignChat campaignId={campaign.id} campaignName={campaign.name} fill />
          </div>
        </div>
      </aside>

      {/* Mobile/narrow fallback: chat below content */}
      <div className="xl:hidden mt-6">
        <h2 className="section-title mb-3">Campaign chat</h2>
        <CampaignChat campaignId={campaign.id} campaignName={campaign.name} />
      </div>
    </div>
  );
}
