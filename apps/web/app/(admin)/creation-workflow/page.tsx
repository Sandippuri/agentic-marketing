// /creation-workflow — engine-agnostic live view of every workflow run.
//
// Reads from the unified workflow_runs table so all engines (custom,
// vercel, cloudflare-future) appear in one list. For custom-engine runs
// we additionally join through engine_run_ref → generation_jobs to render
// the per-sub-agent step pipeline; non-custom runs render the same card
// shape with empty step pipelines (the workflow body itself updates the
// terminal status on workflow_runs).
//
// Read-only — does NOT influence the engines. Realtime updates flow via
// the existing Supabase CDC invalidator (see lib/realtime-invalidator).

import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { listEngineDescriptors } from "@/lib/workflow-engines";
import { getWorkspaceContext } from "@/lib/billing";
import {
  DEFAULT_WORKFLOW_ENGINE,
  getModelInfo,
  resolveWorkflowEngine,
} from "@marketing/shared-types";
import { JobsView, type JobView, type StepView } from "./jobs-view";
import { StartForm, type CampaignOption } from "./start-form";
import { PageHeader, Badge } from "../ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// All known step names in pipeline order. Steps that didn't run are
// rendered as 'pending' placeholders so the visual progression is clear
// even when only a subset fires.
const PIPELINE: Array<StepView["name"]> = [
  "researcher",
  "strategist",
  "content",
  "asset",
  "analyst",
  "distributor",
];

export default async function CreationWorkflowPage() {
  // Live view of this workspace's workflow runs. Workspace-scoped reads
  // (see queries below) keep tenants isolated.
  const db = getDb();
  const ctx = await getWorkspaceContext();

  // Primary list: workflow_runs across all engines. We pull more than we
  // display so the client-side filtering has data.
  const [runs, campaignsForForm, settingsRows] = await Promise.all([
    db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workspaceId, ctx.workspaceId))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(50),
    db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        slug: schema.campaigns.slug,
      })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.workspaceId, ctx.workspaceId))
      .orderBy(desc(schema.campaigns.createdAt))
      .limit(50),
    // Settings: prefer workspace-specific row, fall back to global default
    // (workspace_id IS NULL). Both rows may be present; we sort below.
    db
      .select()
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, "workflow_engine"),
          or(
            eq(schema.settings.workspaceId, ctx.workspaceId),
            isNull(schema.settings.workspaceId),
          ),
        ),
      ),
  ]);
  const campaignOptions: CampaignOption[] = campaignsForForm;
  const workspaceSettingRow =
    settingsRows.find((r) => r.workspaceId === ctx.workspaceId) ??
    settingsRows.find((r) => r.workspaceId === null);
  const globalEngine = resolveWorkflowEngine(
    workspaceSettingRow?.value ?? DEFAULT_WORKFLOW_ENGINE,
  );

  // Custom-engine runs reference generation_jobs.id via engine_run_ref. We
  // pull those parents + their steps so the card can render the full
  // sub-agent pipeline. Non-custom runs render with an empty steps array.
  const customRefs = runs
    .filter((r) => r.engine === "custom" && r.engineRunRef)
    .map((r) => r.engineRunRef as string);

  const generationJobs = customRefs.length
    ? await db
        .select()
        .from(schema.generationJobs)
        .where(
          and(
            eq(schema.generationJobs.workspaceId, ctx.workspaceId),
            inArray(schema.generationJobs.id, customRefs),
          ),
        )
    : [];
  const generationJobById = new Map(generationJobs.map((g) => [g.id, g]));

  const jobIds = generationJobs.map((g) => g.id);
  // generationJobSteps has no workspaceId column — scoped transitively via
  // jobId, which already filtered to this workspace's generation jobs above.
  const stepRows = jobIds.length
    ? await db
        .select()
        .from(schema.generationJobSteps)
        .where(inArray(schema.generationJobSteps.jobId, jobIds))
        .orderBy(schema.generationJobSteps.startedAt)
    : [];

  // Look up linked content/campaign labels (small N — at most 50 runs).
  const contentIds = runs
    .map((r) => r.contentId)
    .filter((v): v is string => !!v);
  const campaignIds = runs
    .map((r) => r.campaignId)
    .filter((v): v is string => !!v);

  const [contentRows, campaignRows, contentAssetRows, approvalRows, agentRevisionRows] = await Promise.all([
    contentIds.length
      ? db
          .select({
            id: schema.contentItems.id,
            title: schema.contentItems.title,
            status: schema.contentItems.status,
          })
          .from(schema.contentItems)
          .where(
            and(
              eq(schema.contentItems.workspaceId, ctx.workspaceId),
              inArray(schema.contentItems.id, contentIds),
            ),
          )
      : Promise.resolve([]),
    campaignIds.length
      ? db
          .select({
            id: schema.campaigns.id,
            name: schema.campaigns.name,
            slug: schema.campaigns.slug,
          })
          .from(schema.campaigns)
          .where(
            and(
              eq(schema.campaigns.workspaceId, ctx.workspaceId),
              inArray(schema.campaigns.id, campaignIds),
            ),
          )
      : Promise.resolve([]),
    // Pull every asset linked to any in-flight content_id so the dashboard
    // can preview variants for Vercel/Cloudflare runs (which don't stream
    // per-step rows). The asset step in single-post inserts these as soon
    // as the images upload, before the approval hook suspends.
    contentIds.length
      ? db
          .select({
            id: schema.assets.id,
            contentId: schema.assets.contentId,
            kind: schema.assets.kind,
            storagePath: schema.assets.storagePath,
            mimeType: schema.assets.mimeType,
            createdAt: schema.assets.createdAt,
          })
          .from(schema.assets)
          .where(
            and(
              eq(schema.assets.workspaceId, ctx.workspaceId),
              inArray(schema.assets.contentId, contentIds),
            ),
          )
          // Chronological so the variants strip reads left-to-right as
          // "original → revision 1 → revision 2". Without an order the
          // revised image can land before the original and confuse readers.
          .orderBy(schema.assets.createdAt)
      : Promise.resolve([]),
    // Latest approval decision per content_id, so the Approval stage chip
    // can distinguish "approval timed out" from "reviewer requested changes"
    // / "rejected" — all three otherwise look identical (status === "draft").
    contentIds.length
      ? db
          .select({
            contentId: schema.approvals.contentId,
            decision: schema.approvals.decision,
            decidedAt: schema.approvals.decidedAt,
          })
          .from(schema.approvals)
          .where(
            and(
              eq(schema.approvals.workspaceId, ctx.workspaceId),
              inArray(schema.approvals.contentId, contentIds),
            ),
          )
      : Promise.resolve([]),
    // Agent-authored revisions per content_id. The single-post workflow
    // inserts one row each time it revises in response to a changes_requested
    // approval, so counting them gives "this run is on revision N" without a
    // dedicated workflow_runs column.
    contentIds.length
      ? db
          .select({
            contentId: schema.contentRevisions.contentId,
            authorKind: schema.contentRevisions.authorKind,
          })
          .from(schema.contentRevisions)
          .where(
            and(
              eq(schema.contentRevisions.workspaceId, ctx.workspaceId),
              inArray(schema.contentRevisions.contentId, contentIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  const contentById = new Map(contentRows.map((r) => [r.id, r]));
  const campaignById = new Map(campaignRows.map((r) => [r.id, r]));

  // Pick the most-recently-decided approval per contentId. Pending rows
  // (decision: null) don't override an already-decided one — the dashboard
  // chip cares about the last terminal verdict.
  const latestDecisionByContentId = new Map<
    string,
    "approved" | "changes_requested" | "rejected"
  >();
  const latestDecidedAtByContentId = new Map<string, number>();
  for (const a of approvalRows) {
    if (!a.contentId || !a.decision) continue;
    const ts = a.decidedAt ? a.decidedAt.getTime() : 0;
    const prev = latestDecidedAtByContentId.get(a.contentId) ?? -1;
    if (ts >= prev) {
      latestDecidedAtByContentId.set(a.contentId, ts);
      latestDecisionByContentId.set(a.contentId, a.decision);
    }
  }

  // Count agent revisions per content_id. Human edits via the UI also land
  // in content_revisions; we only want the ones the workflow itself created
  // so the card chip stays an honest "workflow revised this N times".
  const agentRevisionCountByContentId = new Map<string, number>();
  for (const r of agentRevisionRows) {
    if (!r.contentId || r.authorKind !== "agent") continue;
    agentRevisionCountByContentId.set(
      r.contentId,
      (agentRevisionCountByContentId.get(r.contentId) ?? 0) + 1,
    );
  }

  // Sign each asset's storage path once, in parallel, then group by
  // contentId so each card can render its own variant strip. Cap to keep
  // the page fast when many runs accumulate.
  const signedContentAssets = await Promise.all(
    contentAssetRows.slice(0, 60).map(async (a) => ({
      id: a.id,
      contentId: a.contentId as string,
      kind: a.kind,
      mimeType: a.mimeType,
      signedUrl: await getSignedAssetUrl(a.storagePath).catch(() => null),
    })),
  );
  const assetsByContentId = new Map<
    string,
    Array<{
      id: string;
      kind: string;
      mimeType: string | null;
      signedUrl: string | null;
    }>
  >();
  for (const a of signedContentAssets) {
    if (!a.contentId) continue;
    const list = assetsByContentId.get(a.contentId) ?? [];
    list.push({
      id: a.id,
      kind: a.kind,
      mimeType: a.mimeType,
      signedUrl: a.signedUrl,
    });
    assetsByContentId.set(a.contentId, list);
  }

  // Resolve any image storage paths surfaced in step outputs into signed
  // URLs so the UI can preview generated assets inline. Cap the lookup so
  // we don't pay for signed URLs we'll never render.
  const storagePaths = new Set<string>();
  for (const step of stepRows) {
    if (step.name === "asset" && step.output) {
      for (const path of extractStoragePaths(step.output)) {
        storagePaths.add(path);
      }
    }
  }
  const signedUrlEntries = await Promise.all(
    [...storagePaths].slice(0, 30).map(async (path) => {
      try {
        return [path, await getSignedAssetUrl(path)] as const;
      } catch {
        return [path, null] as const;
      }
    }),
  );
  const signedUrlByPath = new Map(signedUrlEntries);

  const jobViews: JobView[] = runs.map((r) => {
    // For custom-engine runs, render the full sub-agent pipeline by
    // joining to generation_jobs via engine_run_ref. Non-custom engines
    // don't have this detail (yet) — they render with an empty pipeline
    // and rely on the run-level status/error from workflow_runs.
    const generationJob =
      r.engine === "custom" && r.engineRunRef
        ? generationJobById.get(r.engineRunRef)
        : undefined;
    const stepsForJob = generationJob
      ? stepRows.filter((s) => s.jobId === generationJob.id)
      : [];
    const ranByName = new Map<StepView["name"], StepView>();
    for (const step of stepsForJob) {
      ranByName.set(step.name, {
        id: step.id,
        name: step.name,
        status: step.status,
        input: step.input,
        output: step.output,
        error: step.error,
        startedAt: step.startedAt.toISOString(),
        completedAt: step.completedAt ? step.completedAt.toISOString() : null,
        durationMs:
          step.completedAt && step.startedAt
            ? new Date(step.completedAt).getTime() -
              new Date(step.startedAt).getTime()
            : null,
        imageUrls: extractImageUrls(step.output, signedUrlByPath),
      });
    }
    const ordered: StepView[] = PIPELINE.filter((name) =>
      ranByName.has(name),
    ).map((name) => ranByName.get(name)!);

    const linkedContent = r.contentId ? contentById.get(r.contentId) : undefined;
    const linkedCampaign = r.campaignId
      ? campaignById.get(r.campaignId)
      : undefined;

    const inputModel =
      r.input && typeof r.input === "object"
        ? (r.input as { model?: unknown }).model
        : undefined;
    const modelId = typeof inputModel === "string" ? inputModel : null;
    const model = modelId
      ? {
          id: modelId,
          label: getModelInfo(modelId)?.label ?? modelId,
          provider: getModelInfo(modelId)?.provider ?? null,
        }
      : null;

    // Prefer custom-engine status when present (it's updated mid-flight by
    // the GenerationTracker). Otherwise fall back to workflow_runs.status.
    const status = generationJob ? generationJob.status : r.status;
    const error = generationJob?.error ?? r.error ?? null;
    const completedAt =
      (generationJob?.completedAt ?? r.completedAt)?.toISOString() ?? null;

    return {
      id: r.id,
      engine: r.engine,
      engineRunRef: r.engineRunRef,
      threadRef: r.threadRef,
      userId: r.userId,
      userMessage: r.request,
      kind: r.kind,
      status,
      currentStep: generationJob?.currentStep ?? null,
      error,
      startedAt: r.startedAt.toISOString(),
      completedAt,
      steps: ordered,
      linkedContent: linkedContent
        ? {
            id: linkedContent.id,
            title: linkedContent.title,
            status: linkedContent.status,
          }
        : null,
      latestApprovalDecision: r.contentId
        ? latestDecisionByContentId.get(r.contentId) ?? null
        : null,
      agentRevisionCount: r.contentId
        ? agentRevisionCountByContentId.get(r.contentId) ?? 0
        : 0,
      linkedCampaign: linkedCampaign
        ? {
            id: linkedCampaign.id,
            name: linkedCampaign.name,
            slug: linkedCampaign.slug,
          }
        : null,
      model,
      contentAssets: r.contentId
        ? (assetsByContentId.get(r.contentId) ?? [])
        : [],
    };
  });

  const engineDescriptors = listEngineDescriptors();
  const globalEngineDescriptor =
    engineDescriptors.find((e) => e.id === globalEngine) ?? null;

  const runningCount = jobViews.filter((j) => j.status === "running").length;

  return (
    <div>
      <PageHeader
        title="Creation workflow"
        meta={
          <>
            {runningCount > 0 ? (
              <Badge tone="info" dot>
                {runningCount} running
              </Badge>
            ) : (
              <Badge tone="neutral">idle</Badge>
            )}
            <Badge tone="neutral">{jobViews.length} recent</Badge>
          </>
        }
      />
      <StartForm
        campaigns={campaignOptions}
        engine={globalEngine}
        engineDescriptor={globalEngineDescriptor}
        defaultOpen={jobViews.length === 0}
      />
      <JobsView jobs={jobViews} />
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

// Walk a JSON-ish value and pull out any storage_path-looking strings the
// asset sub-agent might have surfaced. Recurses through arrays/objects.
function extractStoragePaths(value: unknown): string[] {
  const found: string[] = [];
  const visit = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") {
      // Heuristic: storage paths are non-URL slash-separated strings.
      if (
        v.length > 4 &&
        v.length < 400 &&
        !v.startsWith("http") &&
        v.includes("/")
      ) {
        found.push(v);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (typeof obj.storagePath === "string") found.push(obj.storagePath);
      if (typeof obj.storage_path === "string") found.push(obj.storage_path);
      for (const key of Object.keys(obj)) visit(obj[key]);
    }
  };
  visit(value);
  return found;
}

// Pull URL-like strings from a step output AND map any storage paths we
// resolved upstream into signed URLs.
function extractImageUrls(
  value: unknown,
  signedByPath: Map<string, string | null>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") {
      if (
        v.startsWith("http") &&
        /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(v) &&
        !seen.has(v)
      ) {
        seen.add(v);
        out.push(v);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      // Common asset fields produced by run_asset / image_gen.
      for (const key of ["url", "imageUrl", "image_url", "signedUrl"]) {
        if (typeof obj[key] === "string") visit(obj[key]);
      }
      for (const key of ["storagePath", "storage_path"]) {
        if (typeof obj[key] === "string") {
          const signed = signedByPath.get(obj[key] as string);
          if (signed && !seen.has(signed)) {
            seen.add(signed);
            out.push(signed);
          }
        }
      }
      for (const key of Object.keys(obj)) visit(obj[key]);
    }
  };
  visit(value);
  for (const path of extractStoragePaths(value)) {
    const signed = signedByPath.get(path);
    if (signed && !seen.has(signed)) {
      seen.add(signed);
      out.push(signed);
    }
  }
  return out.slice(0, 6);
}

