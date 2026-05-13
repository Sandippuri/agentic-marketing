import { defineHook, sleep } from "workflow";
import { z } from "zod";
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import { CHANNELS, type Channel, type LlmModel } from "@marketing/shared-types";
import { kickVideoVariant } from "@/lib/asset-variants";
import { finishRun } from "@/lib/workflow-engines/runs";
import { assetPipelineWorkflow } from "./asset-pipeline";
import { publishWorkflow } from "./publish";

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

const CHANNEL_TO_CONTENT_TYPE: Record<Channel, "blog" | "linkedin" | "x_post" | "x_thread" | "email"> = {
  internal_blog: "blog",
  linkedin: "linkedin",
  x: "x_post",
  email_hubspot: "email",
  email_mailchimp: "email",
};

export type SinglePostInput = {
  request: string;
  channel: Channel;
  campaignId?: string;
  userId?: string;
  threadRef?: string;
  model?: LlmModel;
  // Set by the unified dispatcher (lib/workflow-engines). When present, the
  // workflow updates the matching workflow_runs row at terminal states so
  // the dashboard reflects completion without polling Vercel.
  workflowRunId?: string;
};

export type SinglePostOutput = {
  contentId: string;
  approvalId: string;
  status:
    | "approved"
    | "changes_requested"
    | "rejected"
    | "timeout"
    | "max_revisions";
  externalUrl?: string;
  revisionCount?: number;
};

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

  try {
    for (let iter = 0; iter <= MAX_REVISIONS; iter++) {
      if (iter === 0) {
        // Draft first, *then* generate assets, *then* expose to the approvals
        // queue. Doing all three in a single submit-then-generate step left a
        // window where the approval row was visible to reviewers before the
        // images existed, so the detail panel had nothing to render and the
        // UI kicked off a manual generate-assets retry against the same
        // content (see /api/content/[id]/generate-assets).
        const draft = await draftStep(input);
        contentId = draft.contentId;
        // Direct await on assetPipelineWorkflow uses the Workflows
        // "flattening" pattern — the child's steps run inline in this run's
        // event log and share one unified history. Calling a `"use workflow"`
        // function from inside a `"use step"` is forbidden, which is why
        // this lives in the workflow body rather than a step wrapper.
        // Best-effort: a misconfigured Replicate/Supabase still lets the
        // approval proceed without imagery.
        await assetPipelineWorkflow({
          contentId,
          request: input.request,
        });
        await kickVideoVariantStep({ contentId });
        approvalId = await submitForApprovalStep({
          contentId,
          campaignId: draft.campaignId,
          workflowRunId: input.workflowRunId,
        });
      } else {
        // Reviewer asked for image changes — regenerate assets before the
        // text revision so the new approval row surfaces fresh imagery from
        // the moment it appears in the queue. Demote prior approved assets
        // first; without it the old winner stays "approved" alongside the
        // new one and the approval modal can't tell which is canonical.
        if (lastReason && IMAGE_FEEDBACK_RE.test(lastReason)) {
          await demotePriorAssetsStep({ contentId: contentId! });
          await assetPipelineWorkflow({
            contentId: contentId!,
            request: `${input.request} — reviewer image feedback: ${lastReason}`,
          });
          await kickVideoVariantStep({ contentId: contentId! });
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
    const [existing] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.slug, slug))
      .limit(1);
    if (existing) {
      campaignId = existing.id;
    } else {
      const [created] = await db
        .insert(schema.campaigns)
        .values({
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
    system:
      "You are a marketing copywriter drafting a single post. " +
      "Return JSON with two keys: title (short, no markdown) and bodyMd (the post body, markdown allowed). " +
      "No commentary, no code fences — just the raw JSON object.",
    prompt: `Draft a ${input.channel} post. Request: ${input.request}`,
  });

  await recordLlmUsage({
    agent: "single-post",
    model: input.model,
    threadRef: input.threadRef ?? null,
    workflowRunId: input.workflowRunId ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });

  const { title, bodyMd } = parseDraftJson(text);
  const contentType = CHANNEL_TO_CONTENT_TYPE[input.channel];

  // Stays in "draft" until the asset pipeline finishes — the approvals
  // queue filters on in_review, so reviewers won't see it until assets
  // are ready.
  const [content] = await db
    .insert(schema.contentItems)
    .values({
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
    .values({ contentId: payload.contentId })
    .returning({ id: schema.approvals.id });

  return approval!.id;
}

async function kickVideoVariantStep(payload: {
  contentId: string;
}): Promise<void> {
  "use step";
  await kickVideoVariant(payload.contentId);
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
    .values({ contentId: payload.contentId })
    .returning({ id: schema.approvals.id });

  return approval!.id;
}

async function runPublishStep(payload: {
  contentId: string;
  channel: Channel;
  threadRef?: string;
}): Promise<{ externalUrl: string }> {
  "use step";
  const db = getDb();
  const [job] = await db
    .insert(schema.publishJobs)
    .values({
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
