/**
 * Goal-loop workflow.
 *
 * The user states a goal (e.g. "grow LinkedIn impressions 30% in 14 days,
 * $50 budget"); the orchestrator creates a campaign with goal_definition +
 * target_metrics + budget_cents + deadline + loop_status='planning' and
 * triggers this workflow.
 *
 * Each iteration:
 *   1. plan         — strategist drafts the next batch of content briefs
 *   2. fanout       — runContent for each brief in parallel; submit_for_review
 *   3. wait approval — Promise.race(approvalHook, sleep timeout) per item
 *   4. branch       — approved → publish; changes_requested → re-run content
 *                     with reviewer reason; rejected → skip
 *   5. publish      — invoke publishWorkflow per approved item
 *   6. sleep 24h    — wait for first metrics
 *   7. measure      — fetch outcomes
 *   8. reevaluate   — call evaluateConvergence; converged/halted → terminate
 *
 * Resume-on-crash: every step appends to goal_events keyed by stepKey
 * (campaign_id, iteration, step_key). Idempotent — replays return the
 * prior payload, so the loop picks up exactly where it left off.
 */
import { defineHook, sleep } from "workflow";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CpClient } from "@marketing/cp-client";
import { runStrategist } from "@marketing/agents/sub-agents/strategist";
import { runContent } from "@marketing/agents/sub-agents/content";
import { evaluateConvergence, type OutcomeSnapshot } from "@/lib/goals/evaluator";
import { appendEvent, findByStepKey } from "@/lib/goals/event-log";
import { assertWithinBudget } from "@/lib/cost/budget-guard";
import { finishRun } from "@/lib/workflow-engines/runs";
import { approvalHook } from "./single-post";
import { publishWorkflow } from "./publish";

export const goalApprovalHook = defineHook({
  schema: z.object({
    decision: z.enum(["approved", "changes_requested", "rejected"]),
    reason: z.string().nullish(),
  }),
});

export type GoalLoopInput = {
  campaignId: string;
  /** Workspace scope; mandatory from PR 4. Threaded via dispatchStart. */
  workspaceId: string;
  /** Maximum iterations before halting; defaults to 6. */
  maxIterations?: number;
  /** When set, the dispatcher updates this workflow_runs row at terminal states. */
  workflowRunId?: string;
};

export type GoalLoopOutput = {
  campaignId: string;
  iterations: number;
  finalState: "converged" | "halted" | "failed";
  reason: string;
};

const DEFAULT_MAX_ITERATIONS = 6;
const APPROVAL_TIMEOUT = "7d";
const MEASURE_DELAY = "24h";

export async function goalLoopWorkflow(
  input: GoalLoopInput,
): Promise<GoalLoopOutput> {
  "use workflow";

  const max = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let iteration = 0;

  try {
    while (iteration < max) {
      // Budget guard. Refreshes campaigns.cost_cents_spent from the
      // authoritative llm_usage rollup and halts the loop if the campaign
      // is at or over budget.
      const budget = await budgetCheckStep({
        campaignId: input.campaignId,
        iteration,
      });
      if (budget.state === "exceeded") {
        await terminateStep({
          campaignId: input.campaignId,
          state: "halted",
          reason: budget.reason,
          iteration,
        });
        await finishWorkflowRunStep({
          workflowRunId: input.workflowRunId,
          status: "completed",
          campaignId: input.campaignId,
        });
        return {
          campaignId: input.campaignId,
          iterations: iteration,
          finalState: "halted",
          reason: budget.reason,
        };
      }

      const briefs = await planStep({
        campaignId: input.campaignId,
        workspaceId: input.workspaceId,
        iteration,
      });
      if (briefs.length === 0) {
        await terminateStep({
          campaignId: input.campaignId,
          state: "halted",
          reason: "no_briefs_returned",
          iteration,
        });
        await finishWorkflowRunStep({
          workflowRunId: input.workflowRunId,
          status: "completed",
          campaignId: input.campaignId,
        });
        return {
          campaignId: input.campaignId,
          iterations: iteration,
          finalState: "halted",
          reason: "no_briefs_returned",
        };
      }

      // Fan out content drafting in parallel. Each brief becomes a
      // content_items row; run_content posts the approval card via
      // postToThread (when wired).
      const drafts = await Promise.all(
        briefs.map((brief, idx) =>
          draftStep({
            campaignId: input.campaignId,
            workspaceId: input.workspaceId,
            iteration,
            briefIndex: idx,
            brief,
          }),
        ),
      );

      // Wait on approvals in parallel. Each approval hook fires when the
      // /api/approvals/[id] PATCH calls approvalHook.resume(token).
      const decisions = await Promise.all(
        drafts.map((d) => waitApproval(d.contentId, d.approvalId)),
      );

      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i]!;
        const decision = decisions[i]!;
        if (decision.decision === "approved") {
          await publishStep({
            campaignId: input.campaignId,
            workspaceId: input.workspaceId,
            iteration,
            contentId: draft.contentId,
            channel: draft.channel,
          });
        } else if (decision.decision === "changes_requested") {
          // Re-run content with reviewer reason; defer the new approval
          // wait to the next iteration to keep this iteration bounded.
          await reviseStep({
            campaignId: input.campaignId,
            workspaceId: input.workspaceId,
            iteration,
            contentId: draft.contentId,
            reason: decision.reason ?? "",
          });
        } else {
          await appendEventStep({
            campaignId: input.campaignId,
            iteration,
            kind: "approval_resolved",
            stepKey: `reject:${draft.contentId}`,
            payload: { contentId: draft.contentId, decision: decision.decision },
          });
        }
      }

      // Wait one measurement window so outcomes have time to accumulate.
      // sleep() is durable: a crash at the boundary resumes here on restart.
      await sleep(MEASURE_DELAY);

      const outcomes = await measureStep({
        campaignId: input.campaignId,
        iteration,
      });

      const verdict = await reevaluateStep({
        campaignId: input.campaignId,
        iteration,
        outcomes,
      });

      iteration++;

      if (verdict.state !== "continue") {
        await terminateStep({
          campaignId: input.campaignId,
          state: verdict.state,
          reason: verdict.reason,
          iteration,
        });
        await finishWorkflowRunStep({
          workflowRunId: input.workflowRunId,
          status: "completed",
          campaignId: input.campaignId,
        });
        return {
          campaignId: input.campaignId,
          iterations: iteration,
          finalState: verdict.state,
          reason: verdict.reason,
        };
      }
    }

    // Exhausted max iterations without converging.
    await terminateStep({
      campaignId: input.campaignId,
      state: "halted",
      reason: "max_iterations_exhausted",
      iteration,
    });
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "completed",
      campaignId: input.campaignId,
    });
    return {
      campaignId: input.campaignId,
      iterations: iteration,
      finalState: "halted",
      reason: "max_iterations_exhausted",
    };
  } catch (err) {
    await appendEventStep({
      campaignId: input.campaignId,
      iteration,
      kind: "error",
      payload: { error: (err as Error).message },
    });
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "failed",
      campaignId: input.campaignId,
      error: (err as Error).message,
    });
    throw err;
  }
}

// ============================================================
// Steps
// ============================================================

type Brief = {
  type: "blog" | "linkedin" | "x_post" | "x_thread" | "email";
  channel:
    | "internal_blog"
    | "linkedin"
    | "x"
    | "email_hubspot"
    | "email_mailchimp";
  title: string;
  prompt: string;
};

async function planStep(args: {
  campaignId: string;
  workspaceId: string;
  iteration: number;
}): Promise<Brief[]> {
  "use step";
  const stepKey = `plan:${args.iteration}`;
  const prior = await findByStepKey(args.campaignId, args.iteration, stepKey);
  if (prior) {
    return (prior.payload as { briefs?: Brief[] }).briefs ?? [];
  }

  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, args.campaignId))
    .limit(1);
  if (!campaign) throw new Error(`campaign not found: ${args.campaignId}`);

  await db
    .update(schema.campaigns)
    .set({ loopStatus: "planning", lastIterationAt: new Date() })
    .where(eq(schema.campaigns.id, args.campaignId));

  // Build the strategist request from the goal definition.
  const goalSummary = (campaign.goalDefinition as { summary?: string } | null)
    ?.summary ?? campaign.briefMd ?? "";
  const request = `Plan iteration ${args.iteration} for goal: ${goalSummary}\n\nReturn a JSON array of 2-5 briefs, each with {type, channel, title, prompt}. Use the KB to ground voice and product facts.`;

  const cp = buildCpClient();
  // Strategist returns Markdown today; for the goal loop we need structured
  // briefs. Until the strategist is upgraded to emit JSON, parse a code-fence
  // JSON block from its output.
  const out = await runStrategist({
    request,
    workspaceId: args.workspaceId,
    campaignId: args.campaignId,
    cp,
  });

  const briefs = parseBriefsFromStrategist(out);

  await appendEvent({
    campaignId: args.campaignId,
    iteration: args.iteration,
    kind: "plan_drafted",
    stepKey,
    payload: { briefs, raw: out.slice(0, 1_000) },
  });

  return briefs;
}

function parseBriefsFromStrategist(text: string): Brief[] {
  const fence = /```json\s*\n([\s\S]*?)\n```/i.exec(text);
  const body = fence?.[1] ?? text;
  try {
    const arr = JSON.parse(body);
    if (!Array.isArray(arr)) return [];
    const allowedChannels = [
      "internal_blog",
      "linkedin",
      "x",
      "email_hubspot",
      "email_mailchimp",
    ] as const;
    const allowedTypes = [
      "blog",
      "linkedin",
      "x_post",
      "x_thread",
      "email",
    ] as const;
    return arr
      .map((b) => ({
        type: allowedTypes.includes(b?.type) ? b.type : "linkedin",
        channel: allowedChannels.includes(b?.channel) ? b.channel : "linkedin",
        title: typeof b?.title === "string" ? b.title : "Untitled",
        prompt: typeof b?.prompt === "string" ? b.prompt : "",
      }))
      .filter((b) => b.prompt.trim().length > 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function draftStep(args: {
  campaignId: string;
  workspaceId: string;
  iteration: number;
  briefIndex: number;
  brief: Brief;
}): Promise<{ contentId: string; approvalId: string; channel: Brief["channel"] }> {
  "use step";
  const stepKey = `draft:${args.iteration}:${args.briefIndex}`;
  const prior = await findByStepKey(args.campaignId, args.iteration, stepKey);
  if (prior) {
    const p = prior.payload as {
      contentId?: string;
      approvalId?: string;
      channel?: Brief["channel"];
    };
    if (p.contentId && p.approvalId && p.channel) {
      return { contentId: p.contentId, approvalId: p.approvalId, channel: p.channel };
    }
  }

  const cp = buildCpClient();
  // Run content sub-agent; it creates a content_items row and an approvals
  // row when it calls submit_for_review internally.
  await runContent({
    request: args.brief.prompt,
    workspaceId: args.workspaceId,
    campaignId: args.campaignId,
    cp,
  });

  // Find the most recent (campaign, draft/in_review) content item produced
  // for this brief title — content sub-agent doesn't return ids today.
  const db = getDb();
  const [item] = await db
    .select({
      id: schema.contentItems.id,
      title: schema.contentItems.title,
    })
    .from(schema.contentItems)
    .where(
      and(
        eq(schema.contentItems.campaignId, args.campaignId),
        eq(schema.contentItems.title, args.brief.title),
      ),
    )
    .orderBy(schema.contentItems.createdAt)
    .limit(1);

  if (!item) throw new Error("draft created but content_items row not found");

  const [approval] = await db
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(eq(schema.approvals.contentId, item.id))
    .orderBy(schema.approvals.requestedAt)
    .limit(1);

  if (!approval) throw new Error("draft submitted but approvals row not found");

  await appendEvent({
    campaignId: args.campaignId,
    iteration: args.iteration,
    kind: "approval_requested",
    stepKey,
    payload: {
      contentId: item.id,
      approvalId: approval.id,
      channel: args.brief.channel,
    },
  });

  return {
    contentId: item.id,
    approvalId: approval.id,
    channel: args.brief.channel,
  };
}

async function waitApproval(
  _contentId: string,
  approvalId: string,
): Promise<{ decision: "approved" | "changes_requested" | "rejected" | "timeout"; reason?: string | null }> {
  // Reuses the existing approvalHook from single-post.ts so the
  // /api/approvals route doesn't need to know about goal-loop separately.
  using hook = approvalHook.create({ token: `approval:${approvalId}` });
  return Promise.race([
    hook,
    sleep(APPROVAL_TIMEOUT).then(() => ({
      decision: "timeout" as const,
      reason: null,
    })),
  ]);
}

async function publishStep(args: {
  campaignId: string;
  workspaceId: string;
  iteration: number;
  contentId: string;
  channel: Brief["channel"];
}): Promise<void> {
  "use step";
  const stepKey = `publish:${args.iteration}:${args.contentId}`;
  const prior = await findByStepKey(args.campaignId, args.iteration, stepKey);
  if (prior) return;

  // Create the publish_jobs row first so publishWorkflow has something to
  // gate + patch. Mode=test by default during goal-loop dev; switch to live
  // once the loop is verified end-to-end.
  const db = getDb();
  const [job] = await db
    .insert(schema.publishJobs)
    .values({
      workspaceId: args.workspaceId,
      contentId: args.contentId,
      channel: args.channel,
      status: "queued",
      mode: process.env.GOAL_LOOP_LIVE === "1" ? "live" : "test",
    })
    .returning({ id: schema.publishJobs.id });
  if (!job) throw new Error("publish_jobs insert returned no rows");

  await publishWorkflow({
    publishJobId: job.id,
    contentId: args.contentId,
    workspaceId: args.workspaceId,
    channel: args.channel,
  });

  await appendEvent({
    campaignId: args.campaignId,
    iteration: args.iteration,
    kind: "published",
    stepKey,
    payload: {
      contentId: args.contentId,
      channel: args.channel,
      publishJobId: job.id,
    },
  });
}

async function reviseStep(args: {
  campaignId: string;
  workspaceId: string;
  iteration: number;
  contentId: string;
  reason: string;
}): Promise<void> {
  "use step";
  const stepKey = `revise:${args.iteration}:${args.contentId}`;
  const prior = await findByStepKey(args.campaignId, args.iteration, stepKey);
  if (prior) return;

  const cp = buildCpClient();
  await runContent({
    request: `Revise the prior draft. Reviewer requested changes: ${args.reason}`,
    workspaceId: args.workspaceId,
    campaignId: args.campaignId,
    contentId: args.contentId,
    cp,
  });

  await appendEvent({
    campaignId: args.campaignId,
    iteration: args.iteration,
    kind: "approval_resolved",
    stepKey,
    payload: { contentId: args.contentId, reason: args.reason, action: "revised" },
  });
}

async function measureStep(args: {
  campaignId: string;
  iteration: number;
}): Promise<OutcomeSnapshot[]> {
  "use step";
  const stepKey = `measure:${args.iteration}`;
  const prior = await findByStepKey(args.campaignId, args.iteration, stepKey);
  if (prior) {
    return (prior.payload as { outcomes?: OutcomeSnapshot[] }).outcomes ?? [];
  }

  const db = getDb();
  // Read the windowed outcomes for content belonging to this campaign.
  const rows = await db
    .select({
      channel: schema.outcomes.channel,
      window: schema.outcomes.window,
      impressions: schema.outcomes.impressions,
      clicks: schema.outcomes.clicks,
      conversions: schema.outcomes.conversions,
      ctr: schema.outcomes.ctr,
      engagementRate: schema.outcomes.engagementRate,
    })
    .from(schema.outcomes)
    .innerJoin(
      schema.contentItems,
      eq(schema.outcomes.contentId, schema.contentItems.id),
    )
    .where(eq(schema.contentItems.campaignId, args.campaignId));

  const outcomes: OutcomeSnapshot[] = rows.map((r) => ({
    channel: r.channel as string,
    window: r.window as "7d" | "30d" | "90d",
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    conversions: Number(r.conversions),
    ctr: Number(r.ctr),
    engagementRate: Number(r.engagementRate),
  }));

  await appendEvent({
    campaignId: args.campaignId,
    iteration: args.iteration,
    kind: "outcome_observed",
    stepKey,
    payload: { outcomes },
  });

  return outcomes;
}

async function reevaluateStep(args: {
  campaignId: string;
  iteration: number;
  outcomes: OutcomeSnapshot[];
}): Promise<{ state: "continue" | "converged" | "halted"; reason: string }> {
  "use step";
  const stepKey = `reevaluate:${args.iteration}`;
  const prior = await findByStepKey(args.campaignId, args.iteration, stepKey);
  if (prior) {
    return prior.payload as { state: "continue" | "converged" | "halted"; reason: string };
  }

  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, args.campaignId))
    .limit(1);
  if (!campaign) throw new Error(`campaign not found: ${args.campaignId}`);

  const verdict = evaluateConvergence({
    campaign: {
      id: campaign.id,
      targetMetrics: (campaign.targetMetrics as never) ?? null,
      budgetCents: campaign.budgetCents ?? null,
      costCentsSpent: campaign.costCentsSpent ?? 0,
      deadline: campaign.deadline ?? null,
      loopIteration: args.iteration,
    },
    outcomes: args.outcomes,
  });

  await db
    .update(schema.campaigns)
    .set({
      loopIteration: args.iteration + 1,
      lastIterationAt: new Date(),
    })
    .where(eq(schema.campaigns.id, args.campaignId));

  await appendEvent({
    campaignId: args.campaignId,
    iteration: args.iteration,
    kind: "reevaluated",
    stepKey,
    payload: verdict,
  });

  return verdict;
}

async function terminateStep(args: {
  campaignId: string;
  state: "converged" | "halted";
  reason: string;
  iteration: number;
}): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .update(schema.campaigns)
    .set({
      loopStatus: args.state,
      lastIterationAt: new Date(),
    })
    .where(eq(schema.campaigns.id, args.campaignId));

  await appendEvent({
    campaignId: args.campaignId,
    iteration: args.iteration,
    kind: args.state === "converged" ? "converged" : "halted",
    stepKey: `terminate:${args.iteration}`,
    payload: { reason: args.reason },
  });
}

async function appendEventStep(args: Parameters<typeof appendEvent>[0]): Promise<void> {
  "use step";
  await appendEvent(args);
}

async function budgetCheckStep(args: {
  campaignId: string;
  iteration: number;
}): Promise<
  | { state: "ok" }
  | { state: "exceeded"; reason: "budget_exceeded" }
> {
  "use step";
  const verdict = await assertWithinBudget(args.campaignId);
  if (verdict.state === "exceeded") {
    await appendEvent({
      campaignId: args.campaignId,
      iteration: args.iteration,
      kind: "halted",
      stepKey: `budget:${args.iteration}`,
      payload: {
        reason: verdict.reason,
        spentCents: verdict.spentCents,
        budgetCents: verdict.budgetCents,
      },
    });
    return { state: "exceeded", reason: verdict.reason };
  }
  return { state: "ok" };
}

async function finishWorkflowRunStep(args: {
  workflowRunId?: string;
  status: "completed" | "failed";
  campaignId?: string;
  error?: string;
}): Promise<void> {
  "use step";
  if (!args.workflowRunId) return;
  await finishRun(args.workflowRunId, {
    status: args.status,
    campaignId: args.campaignId ?? null,
    error: args.error ?? null,
  });
}

function buildCpClient(): CpClient {
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  return new CpClient({ baseUrl, internalToken });
}
