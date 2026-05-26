import { defineHook, sleep } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";
import { generateText } from "ai";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import {
  CHANNELS,
  type Channel,
  type LlmModel,
  type WorkflowMedia,
} from "@marketing/shared-types";
import { finishRun } from "@/lib/workflow-engines/runs";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import type { ImageBrief } from "@marketing/agents/sub-agents/content";
import { assetPipelineWorkflow } from "./asset-pipeline";
import { publishWorkflow } from "./publish";
import { videoVariantWorkflow } from "./video-variant";

// Phase 1 of the Vercel migration. This workflow proves the SDK pattern
// end-to-end without depending on the manager: a /workflow slash command in
// test-chat hits /api/workflows/single-post, which calls start(...) here.
// The workflow drafts a post via a single AI SDK call, submits for review,
// suspends on a hook keyed by approvalId, and resumes when the approvals
// route fires `approvalHook.resume(...)`. Real sub-agent integration
// (runContent / runAsset) lands in Phase 2.

export const approvalHook = defineHook({
  schema: z.object({
    decision: z.enum(["approved", "changes_requested", "rejected"]),
    reason: z.string().nullish(),
  }),
});

// Partial: instagram/facebook are valid channels but have no corresponding
// content_type yet (the enum doesn't include instagram_post / facebook_post).
// draftStep guards against the missing key and throws — far better than a
// silent miscategorisation as "x_post" or similar.
const CHANNEL_TO_CONTENT_TYPE: Partial<Record<Channel, "blog" | "linkedin" | "x_post" | "x_thread" | "email">> = {
  internal_blog: "blog",
  linkedin: "linkedin",
  x: "x_post",
  email_hubspot: "email",
  email_mailchimp: "email",
};

export type SinglePostInput = {
  request: string;
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  channel: Channel;
  campaignId?: string;
  userId?: string;
  threadRef?: string;
  model?: LlmModel;
  // Set by the unified dispatcher (lib/workflow-engines). When present, the
  // workflow updates the matching workflow_runs row at terminal states so
  // the dashboard reflects completion without polling Vercel.
  workflowRunId?: string;
  // Resume path: when set, the workflow skips draftStep + asset generation
  // and enters the loop in revise mode against the existing content row.
  // Used by the redraft button and by retry-on-max_revisions to continue
  // revising instead of orphaning the prior draft and starting fresh.
  contentId?: string;
  /**
   * Storage path of a user-uploaded inspiration image, forwarded to every
   * assetPipelineWorkflow invocation in this run (initial draft and any
   * image-feedback revisions) so the visual stays in the same style across
   * revisions. See /api/uploads/inspiration-images.
   */
  inspirationImagePath?: string;
  /**
   * User-chosen media for this run. Hard override:
   *   - "auto" (default): images via assetPipelineWorkflow + opportunistic
   *     video via videoVariantWorkflow (gated by contentTypeWantsVideo()).
   *   - "image": images only — video kickoff is skipped, needs_video=false.
   *   - "video": video only — image pipeline is skipped, needs_video=true,
   *     video gen is forced regardless of channel allowlist.
   *   - "both": images AND video, both forced (bypasses the type allowlist).
   */
  media?: WorkflowMedia;
};

export type SinglePostOutput = {
  contentId: string;
  approvalId: string;
  status:
    | "approved"
    | "changes_requested"
    | "rejected"
    | "timeout"
    | "max_revisions"
    | "budget_exceeded";
  externalUrl?: string;
  revisionCount?: number;
};

// Per-run USD ceiling. Above this we stop auto-revising even if iter count
// is under MAX_REVISIONS — protects against a model that decides to rewrite
// the whole post each round on a long input. Unset (0/NaN) disables.
function runBudgetUsd(): number {
  const raw = process.env.SINGLE_POST_RUN_BUDGET_USD;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Cap revisions so a chatty reviewer can't burn budget indefinitely. Three
// passes covers the typical "tone tweak → tighter hook → final polish" arc;
// past that the post likely needs a human to take over.
const MAX_REVISIONS = 3;

// Reviewer reasons that target imagery rather than copy. We use this to
// decide whether a revision pass should re-run the asset pipeline — without
// it, "change the images" only reruns the text generator and the approval
// modal comes back with the same images.
const IMAGE_FEEDBACK_RE =
  /\b(image|images|visual|visuals|picture|pictures|photo|photos|graphic|graphics|artwork|illustration|illustrations|thumbnail|thumbnails)\b/i;

export async function singlePostWorkflow(
  input: SinglePostInput,
): Promise<SinglePostOutput> {
  "use workflow";

  let contentId: string | undefined;
  let approvalId: string | undefined;
  let lastReason: string | null = null;

  // Decompose `media` into the two independent decisions the workflow
  // actually needs to make. `auto` keeps legacy behavior: images run, video
  // is opportunistic (gated by contentTypeWantsVideo and per-content
  // needs_video). Any explicit pick is a hard override on both.
  const media: WorkflowMedia = input.media ?? "auto";
  const wantsImage = media === "auto" || media === "image" || media === "both";
  const wantsVideo = media === "video" || media === "both";
  // forceVideo = the user explicitly picked video for THIS run; bypass the
  // VIDEO_ENABLED_CONTENT_TYPES allowlist and the needs_video=false gate.
  const forceVideo = wantsVideo;
  // When the user said image-only, stamp needs_video=false so subsequent
  // image-feedback regen passes don't accidentally kick off Veo again.
  const stampNeedsVideoFalse = media === "image";

  // Resume path. When the caller passes contentId (redraft button or a
  // retry of a max_revisions cancelled run), prime the loop so iter 1 lands
  // straight in reviseAndResubmitStep against the existing content row.
  // lastReason is pulled from the most recent decided changes_requested
  // approval so the model has the reviewer's feedback in context.
  const resume = !!input.contentId;
  if (resume) {
    const primed = await resumeFromContentStep({
      contentId: input.contentId!,
      workflowRunId: input.workflowRunId,
    });
    contentId = primed.contentId;
    lastReason = primed.lastReason;
  }

  try {
    for (let iter = resume ? 1 : 0; iter <= MAX_REVISIONS; iter++) {
      if (iter === 0) {
        // Draft first, *then* generate assets, *then* expose to the approvals
        // queue. Doing all three in a single submit-then-generate step left a
        // window where the approval row was visible to reviewers before the
        // images existed, so the detail panel had nothing to render and the
        // UI kicked off a manual generate-assets retry against the same
        // content (see /api/content/[id]/generate-assets).
        const draft = await draftStep(input);
        contentId = draft.contentId;
        // Persist the media choice onto the content row so subsequent
        // revisions (image-feedback regen path below) honour the same
        // decision and so the approval-panel "Video on/off" toggle reflects
        // what the user originally picked.
        if (stampNeedsVideoFalse) {
          await setNeedsVideoStep({ contentId, value: false });
        } else if (forceVideo) {
          await setNeedsVideoStep({ contentId, value: true });
        }
        // Direct await on assetPipelineWorkflow uses the Workflows
        // "flattening" pattern — the child's steps run inline in this run's
        // event log and share one unified history. Calling a `"use workflow"`
        // function from inside a `"use step"` is forbidden, which is why
        // this lives in the workflow body rather than a step wrapper.
        // Best-effort: a misconfigured Replicate/Supabase still lets the
        // approval proceed without imagery.
        // Even for media=video we still run the image pipeline once so
        // generateVideoVariant has a first-frame for image-to-video — Veo
        // produces far more on-brand clips with i2v than text-only. The
        // image is uploaded but its asset row sits in 'draft' status; the
        // approval card surfaces the video as the canonical artifact.
        if (wantsImage || wantsVideo) {
          await assetPipelineWorkflow({
            workspaceId: input.workspaceId,
            contentId,
            request: input.request,
            inspirationImagePath: input.inspirationImagePath,
          });
        }
        // For media=video we demote the just-generated still so the
        // approval queue doesn't promote an image as the winning asset —
        // the user asked for video; the still is a means, not the output.
        if (media === "video") {
          await demotePriorAssetsStep({ contentId });
        }
        if (wantsVideo || media === "auto") {
          await kickVideoVariantStep({
            contentId,
            workspaceId: input.workspaceId,
            force: forceVideo,
          });
        }
        approvalId = await submitForApprovalStep({
          workspaceId: input.workspaceId,
          contentId,
          campaignId: draft.campaignId,
          workflowRunId: input.workflowRunId,
        });
      } else {
        // Heartbeat: stamp workflow_runs.updated_at the moment we re-enter
        // the loop after a changes_requested resume. The /approvals stuck
        // detection and the resume route both use this timestamp to tell a
        // truly hung workflow apart from one that's mid-revision (image
        // regen alone can run 1–5 min, longer than the original 30s grace).
        await touchWorkflowRunStep({ workflowRunId: input.workflowRunId });

        // Budget guard: stop auto-revising once the run's LLM spend has
        // crossed the per-run USD ceiling. Without this, a reviewer who
        // asks for full rewrites three times can quietly burn the budget.
        const cap = runBudgetUsd();
        if (cap > 0) {
          const spent = await runSpendUsdStep({
            workflowRunId: input.workflowRunId,
          });
          if (spent >= cap) {
            await finishWorkflowRunStep({
              workflowRunId: input.workflowRunId,
              status: "cancelled",
              contentId,
              error: `revision budget exceeded ($${spent.toFixed(2)} / $${cap.toFixed(2)})`,
            });
            return {
              contentId: contentId!,
              approvalId: approvalId!,
              status: "budget_exceeded",
              revisionCount: iter,
            };
          }
        }
        // Reviewer asked for image changes — regenerate assets before the
        // text revision so the new approval row surfaces fresh imagery from
        // the moment it appears in the queue. Demote prior approved assets
        // first; without it the old winner stays "approved" alongside the
        // new one and the approval modal can't tell which is canonical.
        //
        // Honour the run's media pick on regen too: media=image skips the
        // video kickoff, media=video runs the still gen only as a first
        // frame and immediately demotes it.
        if (lastReason && IMAGE_FEEDBACK_RE.test(lastReason)) {
          await demotePriorAssetsStep({ contentId: contentId! });
          // Multimodal brief revision: feed the current winning image + the
          // reviewer's feedback into a vision LLM to produce a NEW imageBrief.
          // Without this, the asset pipeline re-reads the same imageBrief and
          // regenerates near-identical images (the reviewer's "I don't like
          // it" never reaches the brief; it only nudges the prompt).
          await reviseImageBriefStep({
            workspaceId: input.workspaceId,
            contentId: contentId!,
            reason: lastReason,
            model: input.model,
            threadRef: input.threadRef,
            workflowRunId: input.workflowRunId,
          });
          // Second heartbeat right before asset regen — Replicate calls are
          // the longest single step in the revision loop, and we want the
          // stuck detector to see a fresh updated_at *during* that wait, not
          // only at iteration start.
          await touchWorkflowRunStep({ workflowRunId: input.workflowRunId });
          if (wantsImage || wantsVideo) {
            await assetPipelineWorkflow({
              workspaceId: input.workspaceId,
              contentId: contentId!,
              request: `${input.request} — reviewer image feedback: ${lastReason}`,
              inspirationImagePath: input.inspirationImagePath,
            });
            if (media === "video") {
              await demotePriorAssetsStep({ contentId: contentId! });
            }
          }
          if (wantsVideo || media === "auto") {
            await kickVideoVariantStep({
              contentId: contentId!,
              workspaceId: input.workspaceId,
              force: forceVideo,
            });
          }
        }
        approvalId = await reviseAndResubmitStep({
          contentId: contentId!,
          reason: lastReason,
          model: input.model,
          channel: input.channel,
          threadRef: input.threadRef,
          workflowRunId: input.workflowRunId,
        });
      }

      using hook = approvalHook.create({ token: `approval:${approvalId}` });

      // Race the hook against a 7-day timeout so a forgotten review doesn't
      // hang the workflow forever. The first to settle wins.
      const decision = await Promise.race([
        hook,
        sleep("7d").then(() => ({ decision: "timeout" as const, reason: null })),
      ]);

      if (decision.decision === "approved") {
        let externalUrl: string;
        if (process.env.WORKFLOW_PUBLISH === "1") {
          const r = await runPublishStep({
            workspaceId: input.workspaceId,
            contentId: contentId!,
            channel: input.channel,
            threadRef: input.threadRef,
          });
          externalUrl = r.externalUrl;
        } else {
          const r = await publishStubStep({
            contentId: contentId!,
            channel: input.channel,
          });
          externalUrl = r.externalUrl;
        }
        await finishWorkflowRunStep({
          workflowRunId: input.workflowRunId,
          status: "completed",
          contentId,
        });
        return {
          contentId: contentId!,
          approvalId: approvalId!,
          status: "approved",
          externalUrl,
          revisionCount: iter,
        };
      }

      if (decision.decision === "timeout") {
        await markTimeoutStep(contentId!);
        await finishWorkflowRunStep({
          workflowRunId: input.workflowRunId,
          status: "cancelled",
          contentId,
          error: "approval timeout",
        });
        return {
          contentId: contentId!,
          approvalId: approvalId!,
          status: "timeout",
          revisionCount: iter,
        };
      }

      if (decision.decision === "rejected") {
        // Hard reject is terminal — no point reviving it through a revision
        // loop. The workflow ends; a human can spin up a fresh run if they
        // want to take another swing.
        await finishWorkflowRunStep({
          workflowRunId: input.workflowRunId,
          status: "cancelled",
          contentId,
        });
        return {
          contentId: contentId!,
          approvalId: approvalId!,
          status: "rejected",
          revisionCount: iter,
        };
      }

      // changes_requested → loop back into reviseAndResubmitStep with the
      // reviewer's reason. Falls through to MAX_REVISIONS exhaustion below
      // when iter has incremented past the cap.
      lastReason = decision.reason ?? null;
    }

    // Fell through MAX_REVISIONS without an approved/rejected/timeout decision.
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "cancelled",
      contentId,
      error: `max revisions reached (${MAX_REVISIONS})`,
    });
    return {
      contentId: contentId!,
      approvalId: approvalId!,
      status: "max_revisions",
      revisionCount: MAX_REVISIONS,
    };
  } catch (err) {
    // Without this catch, an exception inside any step (e.g. AI provider
    // rejecting `temperature` for Opus 4.7) would bubble out of the
    // workflow without ever reaching finishWorkflowRunStep, leaving the
    // workflow_runs row stuck on "running" forever in the dashboard.
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "failed",
      error: (err as Error).message,
    });
    throw err;
  }
}

async function draftStep(
  input: SinglePostInput,
): Promise<{ contentId: string; campaignId: string }> {
  "use step";

  if (!CHANNELS.includes(input.channel)) {
    throw new Error(`unknown channel: ${input.channel}`);
  }

  const db = getDb();

  // Resolve or create a campaign. Phase 1 drives from test-chat ad-hoc, so
  // we lean on a default "Workflow Test" campaign when the caller didn't
  // pass one.
  let campaignId = input.campaignId;
  if (!campaignId) {
    const slug = "workflow-test";
    // Slug uniqueness is per-workspace as of migration 0027 — scope the lookup
    // by workspace too or two tenants' "workflow-test" rows would collide.
    const [existing] = await db
      .select()
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.workspaceId, input.workspaceId),
          eq(schema.campaigns.slug, slug),
        ),
      )
      .limit(1);
    if (existing) {
      campaignId = existing.id;
    } else {
      const [created] = await db
        .insert(schema.campaigns)
        .values({
          workspaceId: input.workspaceId,
          slug,
          name: "Workflow Test (Phase 1)",
          status: "active",
          phase: "buildup",
        })
        .returning({ id: schema.campaigns.id });
      campaignId = created!.id;
    }
  }

  // Single-shot draft. No tools, no memory loading — Phase 1 is about the
  // workflow shape, not the content quality. Phase 2 swaps this for a call
  // into runContent from @marketing/agents.
  const { text, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(input.model),
    abortSignal: AbortSignal.timeout(90_000),
    maxRetries: 2,
    system:
      "You are a marketing copywriter drafting a single post. " +
      "Return JSON with two keys: title (short, no markdown) and bodyMd (the post body, markdown allowed). " +
      "No commentary, no code fences — just the raw JSON object.",
    prompt: `Draft a ${input.channel} post. Request: ${input.request}`,
  });

  await recordLlmUsage({
    agent: "single-post",
    workspaceId: input.workspaceId,
    model: input.model,
    threadRef: input.threadRef ?? null,
    workflowRunId: input.workflowRunId ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });

  const { title, bodyMd } = parseDraftJson(text);
  const contentType = CHANNEL_TO_CONTENT_TYPE[input.channel];
  if (!contentType) {
    throw new Error(
      `single-post: no content_type mapping for channel ${input.channel} — extend CONTENT_TYPES and CHANNEL_TO_CONTENT_TYPE before drafting`,
    );
  }

  // Stays in "draft" until the asset pipeline finishes — the approvals
  // queue filters on in_review, so reviewers won't see it until assets
  // are ready.
  const [content] = await db
    .insert(schema.contentItems)
    .values({
      workspaceId: input.workspaceId,
      campaignId,
      type: contentType,
      stage: "explain",
      title,
      bodyMd,
      status: "draft",
    })
    .returning({ id: schema.contentItems.id });

  // Link the workflow_runs row to its content/campaign now, while the
  // workflow is still mid-flight. finishWorkflowRunStep only fires at
  // terminal states, so without this the /creation-workflow dashboard
  // can't join through to the assets table while the run sits on the
  // 7-day approval hook — making image previews look "missing".
  if (input.workflowRunId) {
    await db
      .update(schema.workflowRuns)
      .set({
        contentId: content!.id,
        campaignId,
        updatedAt: new Date(),
      })
      .where(eq(schema.workflowRuns.id, input.workflowRunId));
  }

  return { contentId: content!.id, campaignId };
}

async function submitForApprovalStep(payload: {
  workspaceId: string;
  contentId: string;
  campaignId: string;
  workflowRunId?: string;
}): Promise<string> {
  "use step";
  const db = getDb();

  await db
    .update(schema.contentItems)
    .set({ status: "in_review", updatedAt: new Date() })
    .where(eq(schema.contentItems.id, payload.contentId));

  const [approval] = await db
    .insert(schema.approvals)
    .values({
      workspaceId: payload.workspaceId,
      contentId: payload.contentId,
    })
    .returning({ id: schema.approvals.id });

  return approval!.id;
}

// Resume-path priming. Looks up the existing content row to make sure the
// caller isn't asking us to revise something that doesn't exist or already
// shipped, then pulls the latest changes_requested reason so the first
// revision pass has reviewer feedback in context. Also links the
// workflow_runs row to the existing content/campaign so the dashboard
// joins through correctly while the run is in flight.
async function resumeFromContentStep(payload: {
  contentId: string;
  workflowRunId?: string;
}): Promise<{ contentId: string; lastReason: string | null }> {
  "use step";
  const db = getDb();

  const [content] = await db
    .select()
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, payload.contentId))
    .limit(1);
  if (!content) {
    throw new Error(`resume: content not found: ${payload.contentId}`);
  }
  if (content.status === "published" || content.status === "retracted") {
    throw new Error(
      `resume: content ${payload.contentId} is in terminal state ${content.status}`,
    );
  }

  const [latestChangesRequested] = await db
    .select({ reason: schema.approvals.reason })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.contentId, payload.contentId),
        eq(schema.approvals.decision, "changes_requested"),
      ),
    )
    .orderBy(desc(schema.approvals.decidedAt))
    .limit(1);

  if (payload.workflowRunId) {
    await db
      .update(schema.workflowRuns)
      .set({
        contentId: content.id,
        campaignId: content.campaignId,
        updatedAt: new Date(),
      })
      .where(eq(schema.workflowRuns.id, payload.workflowRunId));
  }

  return {
    contentId: content.id,
    lastReason: latestChangesRequested?.reason ?? null,
  };
}

// Dispatch the Veo clip generation as its own background workflow run.
//
// The previous version called kickVideoVariant() — which fired
// generateVideoVariant() with `void` — and that pattern doesn't survive
// inside a workflow step: when the step returns, the serverless function
// instance terminates and the unawaited promise is reaped before Veo can
// finish. The documented Workflows pattern is to call start() from a step,
// which durably launches a child workflow that runs with its own event log
// (see foundations/common-patterns.mdx). The parent continues immediately,
// so submit-for-approval lands right away and the video asset row appears
// in the approval modal a couple of minutes later via the existing React
// Query polling.
async function kickVideoVariantStep(payload: {
  contentId: string;
  workspaceId: string;
  force?: boolean;
}): Promise<void> {
  "use step";
  console.log(
    `[single-post] kicking video-variant workflow contentId=${payload.contentId} workspaceId=${payload.workspaceId} force=${Boolean(payload.force)}`,
  );
  try {
    const run = await start(videoVariantWorkflow, [
      {
        contentId: payload.contentId,
        workspaceId: payload.workspaceId,
        force: payload.force,
      },
    ]);
    console.log(
      `[single-post] video-variant workflow started runId=${run.runId} for contentId=${payload.contentId}`,
    );
  } catch (err) {
    // Don't fail the parent run — the approval card just won't have a video.
    console.warn(
      `[single-post] video-variant start() threw for contentId=${payload.contentId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// Stamps content_items.needs_video so the approval-panel toggle and the
// revision-loop video kickoff stay in sync with the user's submit-time
// pick. We touch it as its own step (rather than rolling it into draftStep)
// so the resume path also gets a chance to set it.
async function setNeedsVideoStep(payload: {
  contentId: string;
  value: boolean;
}): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .update(schema.contentItems)
    .set({ needsVideo: payload.value, updatedAt: new Date() })
    .where(eq(schema.contentItems.id, payload.contentId));
}

// Bumps workflow_runs.updated_at so the /approvals stuck detector and the
// resume route can see that this run is alive between coarse-grained
// terminal updates (draftStep / resumeFromContentStep / finishRun). Called
// at the start of each revision iteration so a slow image-feedback pass
// doesn't read as "stuck" while it's actually mid-flight.
async function touchWorkflowRunStep(payload: {
  workflowRunId?: string;
}): Promise<void> {
  "use step";
  if (!payload.workflowRunId) return;
  const db = getDb();
  await db
    .update(schema.workflowRuns)
    .set({ updatedAt: new Date() })
    .where(eq(schema.workflowRuns.id, payload.workflowRunId));
}

// Sums llm_usage.cost_usd attributed to this workflow_run. Used by the
// revision loop to bail out of further revisions when the run has already
// consumed its USD budget. Returns 0 when workflowRunId is absent so dev
// runs (no dispatcher) keep working.
async function runSpendUsdStep(payload: {
  workflowRunId?: string;
}): Promise<number> {
  "use step";
  if (!payload.workflowRunId) return 0;
  const db = getDb();
  const [agg] = await db
    .select({
      costUsd: sql<number>`coalesce(sum(${schema.llmUsage.costUsd}), 0)::float8`,
    })
    .from(schema.llmUsage)
    .where(eq(schema.llmUsage.workflowRunId, payload.workflowRunId));
  return agg?.costUsd ?? 0;
}

// Demote any currently approved assets back to 'draft' before re-running the
// asset pipeline. The pipeline always inserts new rows and promotes one to
// 'approved'; without this the modal sees two approved candidates and the
// "selected" badge becomes ambiguous.
async function demotePriorAssetsStep(payload: {
  contentId: string;
}): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .update(schema.assets)
    .set({ status: "draft", updatedAt: new Date() })
    .where(
      and(
        eq(schema.assets.contentId, payload.contentId),
        eq(schema.assets.status, "approved"),
      ),
    );
}

// Vision-LLM brief rewrite. When the reviewer asks for image changes, the
// pipeline used to regen with the SAME imageBriefs — producing near-identical
// images. Here we read the currently-approved asset PER SLOT, show each to a
// vision model alongside its brief and the reviewer's words, and persist a
// NEW imageBriefs array. assetPipelineWorkflow.loadContextStep reads
// image_brief, so updating the row before the pipeline runs is enough — no
// signature changes.
//
// Best-effort: any per-slot failure (no approved asset for that slot, sign
// failure, model parse failure) keeps that slot's existing brief in place.
// Other slots still get revised. The pipeline will still regen — just
// without the visual-feedback refinement for the affected slot.
async function reviseImageBriefStep(payload: {
  workspaceId: string;
  contentId: string;
  reason: string;
  model?: LlmModel;
  threadRef?: string;
  workflowRunId?: string;
}): Promise<void> {
  "use step";
  const db = getDb();

  const [content] = await db
    .select({
      imageBriefs: schema.contentItems.imageBriefs,
      bodyMd: schema.contentItems.bodyMd,
      title: schema.contentItems.title,
    })
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, payload.contentId))
    .limit(1);
  if (!content) return;

  const currentBriefs = (content.imageBriefs as ImageBrief[] | null) ?? null;
  if (!currentBriefs || currentBriefs.length === 0) return;

  // Demote step has already run, so the previously-approved asset is now
  // status='draft'. Look for the most recent image asset PER SLOT — that's
  // the one the reviewer actually saw at that position.
  const recentAssetsBySlot = new Map<
    number,
    { storagePath: string }
  >();
  const assetRows = await db
    .select({
      storagePath: schema.assets.storagePath,
      mimeType: schema.assets.mimeType,
      sequenceOrder: schema.assets.sequenceOrder,
      createdAt: schema.assets.createdAt,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.contentId, payload.contentId),
        sql`${schema.assets.mimeType} is null or ${schema.assets.mimeType} like 'image/%'`,
      ),
    )
    .orderBy(desc(schema.assets.createdAt));
  for (const row of assetRows) {
    const slot = row.sequenceOrder ?? 0;
    if (!recentAssetsBySlot.has(slot) && row.storagePath) {
      recentAssetsBySlot.set(slot, { storagePath: row.storagePath });
    }
  }

  const revisedBriefs = await Promise.all(
    currentBriefs.map(async (brief, slot) => {
      const asset = recentAssetsBySlot.get(slot);
      if (!asset) return brief;
      let signedUrl: string;
      try {
        signedUrl = await getSignedAssetUrl(asset.storagePath);
      } catch {
        return brief;
      }
      const briefJson = JSON.stringify(brief, null, 2);
      try {
        const { text, usage, experimental_providerMetadata } = await generateText({
          model: getLanguageModel(payload.model),
          abortSignal: AbortSignal.timeout(90_000),
          maxRetries: 2,
          system:
            "You are an art director revising an image brief based on reviewer feedback. " +
            "You will see the CURRENT generated image, the CURRENT brief (JSON), and the reviewer's feedback. " +
            "Produce a NEW brief that, when re-rendered, will visually differ from what the reviewer saw — " +
            "change subject, composition, must_show, or mood as needed to address the feedback. " +
            "Do NOT just rephrase the existing brief; the next render must look meaningfully different. " +
            'Return JSON with keys: subject (string), composition ("close_up" | "medium" | "wide" | "overhead"), ' +
            "mood (string), overlay_text (string, optional), must_show (string[]), must_not_show (string[]). " +
            "No fences, no commentary — raw JSON only.",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    `# Post title\n${content.title}\n\n` +
                    `# Post body (excerpt)\n${(content.bodyMd ?? "").slice(0, 800)}\n\n` +
                    `# Image slot\n${slot + 1} of ${currentBriefs.length}\n\n` +
                    `# Current image brief (slot ${slot + 1})\n${briefJson}\n\n` +
                    `# Reviewer feedback (applies to the whole post; tailor to this slot)\n${payload.reason}\n\n` +
                    `# Current image at this slot (attached)\nReview the attached image. ` +
                    `Produce the revised brief that addresses the feedback. Output JSON.`,
                },
                { type: "image", image: signedUrl },
              ],
            },
          ],
        });
        await recordLlmUsage({
          agent: "single-post-image-revision",
          workspaceId: payload.workspaceId,
          model: payload.model,
          threadRef: payload.threadRef ?? null,
          workflowRunId: payload.workflowRunId ?? null,
          usage,
          providerMetadata: experimental_providerMetadata,
        });
        return parseImageBrief(text, brief) ?? brief;
      } catch {
        return brief;
      }
    }),
  );

  await db
    .update(schema.contentItems)
    .set({ imageBriefs: revisedBriefs, updatedAt: new Date() })
    .where(eq(schema.contentItems.id, payload.contentId));
}

function parseImageBrief(
  text: string,
  fallback: ImageBrief | null,
): ImageBrief | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const composition = ((): ImageBrief["composition"] => {
    const c = r.composition;
    if (c === "close_up" || c === "medium" || c === "wide" || c === "overhead") return c;
    return fallback?.composition ?? "medium";
  })();
  const subject =
    typeof r.subject === "string" && r.subject.trim() ? r.subject.trim() : fallback?.subject;
  if (!subject) return null;
  return {
    subject,
    composition,
    mood: typeof r.mood === "string" ? r.mood : fallback?.mood ?? "",
    overlay_text:
      typeof r.overlay_text === "string"
        ? r.overlay_text
        : fallback?.overlay_text,
    must_show: Array.isArray(r.must_show)
      ? r.must_show.filter((s): s is string => typeof s === "string")
      : fallback?.must_show ?? [],
    must_not_show: Array.isArray(r.must_not_show)
      ? r.must_not_show.filter((s): s is string => typeof s === "string")
      : fallback?.must_not_show ?? [],
  };
}

// Revision pass driven by the reviewer's `changes_requested` reason. Mirrors
// what the redraft button does in the custom engine, but inlined here so the
// Vercel workflow can stay durable instead of spawning a separate run.
async function reviseAndResubmitStep(payload: {
  contentId: string;
  reason: string | null;
  channel: Channel;
  model?: LlmModel;
  threadRef?: string;
  workflowRunId?: string;
}): Promise<string> {
  "use step";
  const db = getDb();

  const [content] = await db
    .select()
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, payload.contentId))
    .limit(1);
  if (!content) throw new Error(`content not found: ${payload.contentId}`);

  const reason =
    payload.reason ??
    "Reviewer requested changes but provided no specific feedback. " +
      "Tighten the hook, sharpen the body, and keep the same intent.";

  const { text, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(payload.model),
    abortSignal: AbortSignal.timeout(90_000),
    maxRetries: 2,
    system:
      "You are revising an existing marketing post per reviewer feedback. " +
      "Keep the original intent and channel voice; change what the reviewer asked for and nothing else. " +
      "Return JSON with two keys: title (short, no markdown) and bodyMd (the post body, markdown allowed). " +
      "No commentary, no code fences — just the raw JSON object.",
    prompt:
      `Channel: ${payload.channel}\n` +
      `Original title: ${content.title}\n` +
      `Original body:\n${content.bodyMd}\n\n` +
      `Reviewer feedback (changes_requested):\n${reason}`,
  });

  await recordLlmUsage({
    agent: "single-post",
    workspaceId: content.workspaceId,
    model: payload.model,
    threadRef: payload.threadRef ?? null,
    workflowRunId: payload.workflowRunId ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });

  const { title, bodyMd } = parseDraftJson(text);

  // Snapshot the prior body before overwriting so we keep an audit trail of
  // what each revision changed. authorKind 'agent' since the workflow itself
  // is doing the revision (vs. a human editing in the UI).
  const [revision] = await db
    .insert(schema.contentRevisions)
    .values({
      workspaceId: content.workspaceId,
      contentId: payload.contentId,
      bodyMd: content.bodyMd,
      changeNote: `agent revision: ${reason.slice(0, 200)}`,
      authorKind: "agent",
    })
    .returning({ id: schema.contentRevisions.id });

  await db
    .update(schema.contentItems)
    .set({
      title,
      bodyMd,
      status: "in_review",
      currentRevisionId: revision!.id,
      updatedAt: new Date(),
    })
    .where(eq(schema.contentItems.id, payload.contentId));

  // Fresh approvals row — the previous one is already decided
  // (changes_requested) and the API guards against reusing it.
  const [approval] = await db
    .insert(schema.approvals)
    .values({
      workspaceId: content.workspaceId,
      contentId: payload.contentId,
    })
    .returning({ id: schema.approvals.id });

  return approval!.id;
}

async function runPublishStep(payload: {
  workspaceId: string;
  contentId: string;
  channel: Channel;
  threadRef?: string;
}): Promise<{ externalUrl: string }> {
  "use step";
  const db = getDb();
  const [job] = await db
    .insert(schema.publishJobs)
    .values({
      workspaceId: payload.workspaceId,
      contentId: payload.contentId,
      channel: payload.channel,
      status: "queued",
      threadRef: payload.threadRef ?? null,
      mode: "live",
    })
    .returning({ id: schema.publishJobs.id });
  const result = await publishWorkflow({
    publishJobId: job!.id,
    contentId: payload.contentId,
    workspaceId: payload.workspaceId,
    channel: payload.channel,
    threadRef: payload.threadRef,
    mode: "live",
  });
  return {
    externalUrl: result.externalUrl ?? `pending://${job!.id}`,
  };
}

async function publishStubStep(payload: {
  contentId: string;
  channel: Channel;
}): Promise<{ externalUrl: string }> {
  "use step";
  // Phase 1 stub. Phase 2 replaces this with a real publish workflow.
  const externalUrl = `stub://workflow-publish/${payload.channel}/${payload.contentId}`;
  console.log(
    `[single-post.publish-stub] would publish ${payload.contentId} to ${payload.channel}`,
  );
  const db = getDb();
  await db
    .update(schema.contentItems)
    .set({
      status: "published",
      publishedAt: new Date(),
      publishedUrl: externalUrl,
      updatedAt: new Date(),
    })
    .where(eq(schema.contentItems.id, payload.contentId));
  return { externalUrl };
}

async function markTimeoutStep(contentId: string): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .update(schema.contentItems)
    .set({ status: "draft", updatedAt: new Date() })
    .where(eq(schema.contentItems.id, contentId));
  // Also resolve any open approval rows for this content. Without this,
  // the approval stays decision=null and keeps appearing in the queue with
  // content already in "draft" — a state the decide route can't transition
  // out of in the normal in_review -> draft path.
  await db
    .update(schema.approvals)
    .set({
      decision: "changes_requested",
      decidedAt: new Date(),
      reason: "approval timeout",
    })
    .where(
      and(
        eq(schema.approvals.contentId, contentId),
        sql`${schema.approvals.decision} is null`,
      ),
    );
}

async function finishWorkflowRunStep(payload: {
  workflowRunId?: string;
  status: "completed" | "failed" | "cancelled";
  contentId?: string | null;
  campaignId?: string | null;
  error?: string | null;
}): Promise<void> {
  "use step";
  if (!payload.workflowRunId) return;
  // Delegate to finishRun so quota/auth/rate-limit failures page ops via the
  // shared classifier in runs.ts instead of every workflow rolling its own.
  await finishRun(payload.workflowRunId, {
    status: payload.status,
    contentId: payload.contentId ?? null,
    campaignId: payload.campaignId ?? null,
    error: payload.error ?? null,
  });
}

function parseDraftJson(text: string): { title: string; bodyMd: string } {
  // The model occasionally wraps JSON in ```json fences despite instructions —
  // strip the most common shapes before parsing.
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(trimmed) as { title?: unknown; bodyMd?: unknown };
    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : "Untitled draft";
    const bodyMd =
      typeof parsed.bodyMd === "string" ? parsed.bodyMd : trimmed;
    return { title, bodyMd };
  } catch {
    // Fall back to using the raw text as the body.
    return { title: "Untitled draft", bodyMd: text.trim() };
  }
}
