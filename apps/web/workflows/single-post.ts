import { defineHook, sleep } from "workflow";
import { z } from "zod";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import { CHANNELS, type Channel, type LlmModel } from "@marketing/shared-types";
import { generateAssetVariants } from "@/lib/asset-variants";
import { finishRun } from "@/lib/workflow-engines/runs";
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
  status: "approved" | "changes_requested" | "rejected" | "timeout";
  externalUrl?: string;
};

export async function singlePostWorkflow(
  input: SinglePostInput,
): Promise<SinglePostOutput> {
  "use workflow";

  try {
    const { contentId, approvalId } = await draftAndSubmitStep(input);

    // Generate 3 visual variants in parallel so the human reviewer can pick one
    // on the approvals page. Best-effort: if Replicate / Supabase is misconfigured
    // the step logs and returns, leaving the approval to proceed without imagery.
    await generateAssetVariantsStep({
      contentId,
      request: input.request,
    });

    using hook = approvalHook.create({ token: `approval:${approvalId}` });

    // Race the hook against a 7-day timeout so a forgotten review doesn't
    // hang the workflow forever. The first to settle wins.
    const decision = await Promise.race([
      hook,
      sleep("7d").then(() => ({ decision: "timeout" as const, reason: null })),
    ]);

    if (decision.decision === "approved") {
      // Phase 2: real publish path — create a publish_jobs row and run the
      // publish workflow inline (its steps gate on kill-switch + caps and call
      // the channel adapter). When WORKFLOW_PUBLISH is unset and BullMQ is
      // still primary in this env, we keep using the stub so single-post
      // doesn't double-publish.
      let externalUrl: string;
      if (process.env.WORKFLOW_PUBLISH === "1") {
        const r = await runPublishStep({
          contentId,
          channel: input.channel,
          threadRef: input.threadRef,
        });
        externalUrl = r.externalUrl;
      } else {
        const r = await publishStubStep({
          contentId,
          channel: input.channel,
        });
        externalUrl = r.externalUrl;
      }
      await finishWorkflowRunStep({
        workflowRunId: input.workflowRunId,
        status: "completed",
        contentId,
      });
      return { contentId, approvalId, status: "approved", externalUrl };
    }

    if (decision.decision === "timeout") {
      await markTimeoutStep(contentId);
      await finishWorkflowRunStep({
        workflowRunId: input.workflowRunId,
        status: "cancelled",
        contentId,
        error: "approval timeout",
      });
      return { contentId, approvalId, status: "timeout" };
    }

    // Both `rejected` and `changes_requested` mean nothing was published, so
    // mark the run as cancelled. Reporting "completed" here previously made
    // the dashboard light up the Publish stage as if the post shipped.
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "cancelled",
      contentId,
    });
    return { contentId, approvalId, status: decision.decision };
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

async function draftAndSubmitStep(
  input: SinglePostInput,
): Promise<{ contentId: string; approvalId: string }> {
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

  const [content] = await db
    .insert(schema.contentItems)
    .values({
      campaignId,
      type: contentType,
      stage: "explain",
      title,
      bodyMd,
      status: "in_review",
    })
    .returning({ id: schema.contentItems.id });

  const [approval] = await db
    .insert(schema.approvals)
    .values({ contentId: content!.id })
    .returning({ id: schema.approvals.id });

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

  return { contentId: content!.id, approvalId: approval!.id };
}

async function generateAssetVariantsStep(payload: {
  contentId: string;
  request: string;
}): Promise<void> {
  "use step";
  await generateAssetVariants({
    contentId: payload.contentId,
    subject: payload.request,
  });
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
