import { eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { ApprovalRow, type PendingApproval } from "./approval-row";
import { BatchApproveButton } from "./batch-approve-button";
import { getSignedAssetUrl } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

function ageLabel(requestedAt: Date): string {
  const ms = Date.now() - requestedAt.getTime();
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(ms / 60000)}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function ApprovalsPage() {
  const db = getDb();

  // Join approvals → content_items → campaigns for grouping + age display.
  const rows = await db
    .select({
      id: schema.approvals.id,
      contentId: schema.approvals.contentId,
      requestedAt: schema.approvals.requestedAt,
      contentTitle: schema.contentItems.title,
      contentType: schema.contentItems.type,
      contentStage: schema.contentItems.stage,
      contentBodyMd: schema.contentItems.bodyMd,
      campaignId: schema.contentItems.campaignId,
      campaignName: schema.campaigns.name,
    })
    .from(schema.approvals)
    .innerJoin(schema.contentItems, eq(schema.approvals.contentId, schema.contentItems.id))
    .innerJoin(schema.campaigns, eq(schema.contentItems.campaignId, schema.campaigns.id))
    .where(isNull(schema.approvals.decision))
    // Oldest first so stale items surface at the top.
    .orderBy(schema.approvals.requestedAt);

  // For each content item, look up the most recent draft asset (best-effort).
  const assetsByContent = new Map<string, string | null>();
  for (const r of rows) {
    if (!assetsByContent.has(r.contentId)) {
      const [asset] = await db
        .select({ id: schema.assets.id, storagePath: schema.assets.storagePath })
        .from(schema.assets)
        .where(eq(schema.assets.contentId, r.contentId))
        .limit(1);
      if (asset) {
        const signedUrl = await getSignedAssetUrl(asset.storagePath).catch(() => null);
        assetsByContent.set(r.contentId, signedUrl);
      } else {
        assetsByContent.set(r.contentId, null);
      }
    }
  }

  // Group by campaign for batch-approve UI.
  const byCampaign = new Map<string, { name: string; approvals: PendingApproval[] }>();
  for (const r of rows) {
    if (!byCampaign.has(r.campaignId)) {
      byCampaign.set(r.campaignId, { name: r.campaignName, approvals: [] });
    }
    byCampaign.get(r.campaignId)!.approvals.push({
      id: r.id,
      contentId: r.contentId,
      contentTitle: r.contentTitle,
      contentType: r.contentType,
      contentStage: r.contentStage,
      requestedAt: r.requestedAt.toISOString(),
      ageLabel: ageLabel(r.requestedAt),
      assetSignedUrl: assetsByContent.get(r.contentId) ?? null,
      bodyMd: r.contentBodyMd ?? null,
    });
  }

  const total = rows.length;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        {total > 0 && (
          <span className="text-sm text-zinc-500">
            {total} pending
          </span>
        )}
      </div>

      {total === 0 ? (
        <p className="text-zinc-500">Inbox zero. Nothing pending.</p>
      ) : (
        <div className="space-y-8">
          {[...byCampaign.entries()].map(([campaignId, group]) => (
            <section key={campaignId}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-medium text-zinc-700 dark:text-zinc-300">
                  {group.name}
                  <span className="ml-2 text-xs text-zinc-400">
                    ({group.approvals.length})
                  </span>
                </h2>
                {group.approvals.length > 1 && (
                  <BatchApproveButton
                    approvalIds={group.approvals.map((a) => a.id)}
                  />
                )}
              </div>
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4">
                {group.approvals.map((a) => (
                  <ApprovalRow key={a.id} approval={a} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
