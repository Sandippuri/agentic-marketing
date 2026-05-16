import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CAMPAIGN_PHASES, CAMPAIGN_STATUSES } from "@marketing/shared-types";
import { getWorkspaceContext } from "@/lib/billing";
import { NewCampaignForm } from "./new-campaign-form";
import { CampaignRowActions } from "./campaign-row-actions";
import { PageHeader, Badge, Card, CardHeader, EmptyState, statusTone } from "../ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; phase?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();
  const ctx = await getWorkspaceContext();

  const conditions = [eq(schema.campaigns.workspaceId, ctx.workspaceId)];
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
      .where(and(...conditions))
      .orderBy(desc(schema.campaigns.createdAt)),
    db
      .select({
        campaignId: schema.contentItems.campaignId,
        total: sql<number>`count(*)::int`,
        approved: sql<number>`count(*) filter (where ${schema.contentItems.status} = 'approved')::int`,
        published: sql<number>`count(*) filter (where ${schema.contentItems.status} = 'published')::int`,
      })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.workspaceId, ctx.workspaceId))
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

  const filtersActive = !!(params.status || params.phase);
  const totalContent = contentCounts.reduce((s, r) => s + r.total, 0);
  const totalPublished = contentCounts.reduce((s, r) => s + r.published, 0);

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Multi-channel campaigns from buildup through post-launch."
        meta={
          <>
            <Badge tone="neutral">{campaigns.length} {campaigns.length === 1 ? "campaign" : "campaigns"}</Badge>
            <Badge tone="info">{totalContent} content items</Badge>
            <Badge tone="success">{totalPublished} published</Badge>
            {filtersActive && <Badge tone="warn">filtered</Badge>}
          </>
        }
      />

      {/* Filters */}
      <div className="surface mb-5 px-3 py-2.5 flex flex-wrap items-center gap-3">
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">Status</span>
        <SegmentedFilter
          current={params.status ?? null}
          options={[null, ...CAMPAIGN_STATUSES]}
          buildUrl={(v) => buildUrl({ status: v ?? "" })}
        />
        <span className="h-5 w-px bg-[var(--border)] mx-1" />
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">Phase</span>
        <SegmentedFilter
          current={params.phase ?? null}
          options={[null, ...CAMPAIGN_PHASES]}
          buildUrl={(v) => buildUrl({ phase: v ?? "" })}
        />
      </div>

      {/* Campaign list */}
      {campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          description="Create your first campaign below, or kick one off via @marketing plan a campaign in Slack."
        />
      ) : (
        <div className="table-card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phase</th>
                <th>Status</th>
                <th className="text-right">Content</th>
                <th className="text-right">Published</th>
                <th>Created</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const counts = countsByCampaign[c.id];
                const phaseTone =
                  c.phase === "buildup"
                    ? "info"
                    : c.phase === "launch"
                      ? "warn"
                      : "violet";
                return (
                  <tr key={c.id}>
                    <td>
                      <Link
                        href={`/campaigns/${c.id}`}
                        className="font-medium text-ink hover:text-[var(--accent)] transition-colors"
                      >
                        {c.name}
                      </Link>
                      <div className="mono text-[11px] text-faint mt-0.5">{c.slug}</div>
                    </td>
                    <td>
                      <Badge tone={phaseTone}>{c.phase.replace("_", " ")}</Badge>
                    </td>
                    <td>
                      <Badge tone={statusTone(c.status)} dot>
                        {c.status}
                      </Badge>
                    </td>
                    <td className="text-right">
                      {counts ? (
                        <div className="inline-flex items-center gap-1.5">
                          <span className="text-ink font-medium tabular-nums">{counts.total}</span>
                          {counts.approved > 0 && (
                            <span className="text-[var(--success)] text-xs tabular-nums">
                              · {counts.approved} approved
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums text-mid">
                      {counts?.published ?? "—"}
                    </td>
                    <td className="text-mid mono text-xs whitespace-nowrap">
                      {new Date(c.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "2-digit",
                        year: "numeric",
                      })}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <CampaignRowActions
                        campaign={{
                          id: c.id,
                          name: c.name,
                          phase: c.phase,
                          status: c.status,
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* New campaign */}
      <div className="mt-8">
        <Card>
          <CardHeader
            title="New campaign"
            description="Quick-start a campaign with a slug, name, and phase. Strategy and content can come from the agent."
          />
          <div className="mt-4">
            <NewCampaignForm />
          </div>
        </Card>
      </div>
    </div>
  );
}

function SegmentedFilter({
  current,
  options,
  buildUrl,
}: {
  current: string | null;
  options: (string | null)[];
  buildUrl: (v: string | null) => string;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
      {options.map((opt) => {
        const active = (current ?? null) === (opt ?? null);
        const label = opt === null ? "All" : opt.replace("_", " ");
        return (
          <Link
            key={opt ?? "_all"}
            href={buildUrl(opt)}
            className={[
              "px-2.5 py-1 text-[12px] rounded capitalize transition-colors",
              active
                ? "bg-[var(--bg-elevated)] text-ink shadow-sm"
                : "text-mid hover:text-ink",
            ].join(" ")}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
