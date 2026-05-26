import { eq, isNull, and, isNotNull, desc, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { type PendingApproval } from "./approval-row";
import { ApprovalsShell } from "./approvals-shell";
import { StuckWorkflowRow, type StuckWorkflow } from "./stuck-workflow-row";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { getWorkspaceContext } from "@/lib/billing";
import { PageHeader, EmptyState, Badge } from "../ui";

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
  const ctx = await getWorkspaceContext();

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
      contentNeedsImages: schema.contentItems.needsImages,
      contentNeedsVideo: schema.contentItems.needsVideo,
      campaignId: schema.contentItems.campaignId,
      campaignName: schema.campaigns.name,
    })
    .from(schema.approvals)
    .innerJoin(schema.contentItems, eq(schema.approvals.contentId, schema.contentItems.id))
    .innerJoin(schema.campaigns, eq(schema.contentItems.campaignId, schema.campaigns.id))
    .where(
      and(
        eq(schema.approvals.workspaceId, ctx.workspaceId),
        isNull(schema.approvals.decision),
      ),
    )
    // Oldest first so stale items surface at the top.
    .orderBy(schema.approvals.requestedAt);

  // For each content item, look up all asset variants so the reviewer can
  // pick one. The sub-agent generates ~3 per post; signing URLs in parallel
  // keeps the page fast even at higher fanout.
  type AssetOption = {
    id: string;
    signedUrl: string | null;
    status: string;
    kind: string;
    mimeType: string | null;
    promptUsed: string | null;
    sequenceOrder: number;
  };
  const assetsByContent = new Map<string, AssetOption[]>();
  for (const r of rows) {
    if (!assetsByContent.has(r.contentId)) {
      const found = await db
        .select({
          id: schema.assets.id,
          storagePath: schema.assets.storagePath,
          status: schema.assets.status,
          kind: schema.assets.kind,
          mimeType: schema.assets.mimeType,
          promptUsed: schema.assets.promptUsed,
          sequenceOrder: schema.assets.sequenceOrder,
          createdAt: schema.assets.createdAt,
        })
        .from(schema.assets)
        .where(
          and(
            eq(schema.assets.workspaceId, ctx.workspaceId),
            eq(schema.assets.contentId, r.contentId),
          ),
        )
        // Slot first (so the detail panel can group), then createdAt within
        // the slot (oldest → newest, matching the existing variant strip
        // ordering).
        .orderBy(schema.assets.sequenceOrder, schema.assets.createdAt);
      const signed = await Promise.all(
        found.map(async (a) => ({
          id: a.id,
          status: a.status,
          kind: a.kind,
          mimeType: a.mimeType,
          promptUsed: a.promptUsed,
          sequenceOrder: a.sequenceOrder ?? 0,
          signedUrl: await getSignedAssetUrl(a.storagePath).catch(() => null),
        })),
      );
      assetsByContent.set(r.contentId, signed);
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
      assets: assetsByContent.get(r.contentId) ?? [],
      bodyMd: r.contentBodyMd ?? null,
      needsImages: r.contentNeedsImages,
      needsVideo: r.contentNeedsVideo,
    });
  }

  const total = rows.length;

  // Stuck workflows: workflow_runs still status='running' for kind='single_post'
  // whose latest approval is already decided. These are workflows where the
  // decide route persisted the decision but approvalHook.resume() failed —
  // surface them so the operator can manually re-fire the hook.
  //
  // Grace period: the decide route persists the decision before the workflow's
  // finishWorkflowRunStep flips workflow_runs to 'completed', so a freshly
  // decided approval would briefly look stuck. After `changes_requested` the
  // workflow then runs a full revision pipeline (asset regen on image
  // feedback can take 1–5 min) before inserting the next pending approval
  // row — so we wait 10 min on `decided_at` AND require `updated_at` to be
  // equally stale before flagging. The revision loop heartbeats
  // workflow_runs.updated_at in touchWorkflowRunStep, so an active run
  // keeps the row warm and stays out of this list.
  //
  // The NOT EXISTS guard handles the post-revision window where a new
  // pending approval row already exists; the heartbeat handles the
  // pre-revision window where it doesn't yet. Without both guards, the
  // Re-fire button would force-cancel an actively running revision via the
  // HookNotFoundError reconcile path in /api/approvals/[id]/resume.
  const STUCK_GRACE_MS = 10 * 60_000;
  const stuckCutoff = new Date(Date.now() - STUCK_GRACE_MS);
  const stuckRows = await db
    .select({
      approvalId: schema.approvals.id,
      contentId: schema.approvals.contentId,
      decision: schema.approvals.decision,
      decidedAt: schema.approvals.decidedAt,
      reason: schema.approvals.reason,
      contentTitle: schema.contentItems.title,
      contentType: schema.contentItems.type,
      campaignName: schema.campaigns.name,
      workflowRunId: schema.workflowRuns.id,
      engineRunRef: schema.workflowRuns.engineRunRef,
    })
    .from(schema.workflowRuns)
    .innerJoin(
      schema.contentItems,
      eq(schema.workflowRuns.contentId, schema.contentItems.id),
    )
    .innerJoin(
      schema.approvals,
      eq(schema.approvals.contentId, schema.contentItems.id),
    )
    .innerJoin(
      schema.campaigns,
      eq(schema.contentItems.campaignId, schema.campaigns.id),
    )
    .where(
      and(
        eq(schema.workflowRuns.workspaceId, ctx.workspaceId),
        eq(schema.workflowRuns.status, "running"),
        eq(schema.workflowRuns.kind, "single_post"),
        isNotNull(schema.workflowRuns.contentId),
        isNotNull(schema.approvals.decision),
        lt(schema.approvals.decidedAt, stuckCutoff),
        // The run must also be quiet on its own clock — an in-flight
        // revision pass heartbeats updated_at so a slow image regen
        // (Replicate can take minutes) doesn't show up as stuck mid-flight.
        lt(schema.workflowRuns.updatedAt, stuckCutoff),
        sql`not exists (select 1 from ${schema.approvals} a2 where a2.content_id = ${schema.contentItems.id} and a2.requested_at > ${schema.approvals.requestedAt} and a2.decision is null)`,
      ),
    )
    .orderBy(desc(schema.approvals.decidedAt));

  // De-dupe by workflowRunId — pick the most recent approval per run.
  const stuckByRun = new Map<string, StuckWorkflow>();
  for (const r of stuckRows) {
    if (stuckByRun.has(r.workflowRunId)) continue;
    if (!r.decision || !r.decidedAt) continue;
    stuckByRun.set(r.workflowRunId, {
      approvalId: r.approvalId,
      contentId: r.contentId,
      contentTitle: r.contentTitle,
      contentType: r.contentType,
      campaignName: r.campaignName,
      decision: r.decision,
      decidedAt: r.decidedAt.toISOString(),
      reason: r.reason,
      workflowRunId: r.workflowRunId,
      engineRunRef: r.engineRunRef,
      ageLabel: ageLabel(r.decidedAt),
    });
  }
  const stuck = [...stuckByRun.values()];

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Items waiting on a human decision before they advance through the pipeline."
        meta={
          total > 0 || stuck.length > 0 ? (
            <>
              {total > 0 && (
                <Badge tone="warn" dot>
                  {total} pending
                </Badge>
              )}
              {total > 0 && (
                <Badge tone="neutral">
                  {byCampaign.size} {byCampaign.size === 1 ? "campaign" : "campaigns"}
                </Badge>
              )}
              {stuck.length > 0 && (
                <Badge tone="danger" dot>
                  {stuck.length} stuck
                </Badge>
              )}
            </>
          ) : null
        }
      />

      {stuck.length > 0 && (
        <section className="surface mb-6">
          <header className="flex items-center justify-between gap-3 px-5 py-3 hairline-b">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="grid place-items-center h-7 w-7 rounded-md bg-[color-mix(in_oklab,var(--danger)_20%,transparent)] text-[var(--danger)] shrink-0">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
              </span>
              <h2 className="text-sm font-semibold text-ink truncate">Stuck workflows</h2>
              <Badge tone="danger">{stuck.length}</Badge>
            </div>
            <span className="text-xs text-mid">
              Decided in DB but the workflow hook never resumed. Re-fire to unblock.
            </span>
          </header>
          <ul className="divide-y divide-[var(--border)]">
            {stuck.map((s) => (
              <StuckWorkflowRow key={s.workflowRunId} run={s} />
            ))}
          </ul>
        </section>
      )}

      {total === 0 && stuck.length === 0 ? (
        <EmptyState
          title="Inbox zero"
          description="Nothing is waiting on you. New items appear here the moment an agent requests review."
          icon={
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 12h-6l-2 3h-4l-2-3H2" />
              <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
            </svg>
          }
        />
      ) : total > 0 ? (
        <ApprovalsShell
          groups={[...byCampaign.entries()].map(([campaignId, group]) => ({
            campaignId,
            name: group.name,
            approvals: group.approvals,
          }))}
        />
      ) : null}
    </div>
  );
}
