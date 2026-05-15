/**
 * POST /api/goals — create a goal-driven campaign and start the goal loop.
 *
 * Body: {
 *   summary: string,            // human description of the goal
 *   targetMetrics: TargetMetric[],
 *   budgetCents?: number,
 *   deadline?: string (ISO),
 *   maxIterations?: number,
 *   campaignName?: string,
 *   campaignSlug?: string,
 * }
 *
 * Creates a campaigns row with goal_definition + target_metrics + budget /
 * deadline + loop_status='planning', then starts goalLoopWorkflow. Returns
 * { campaignId, workflowRunId? }.
 *
 * GET /api/goals — list active goals (campaigns where loop_status not in
 * ('idle','converged','halted','failed')).
 */
import { z } from "zod";
import { start } from "workflow/api";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getRequestActor } from "@/lib/auth";
import { getWorkspaceContext } from "@/lib/billing";
import { errorResponse, parseJson } from "@/lib/http";
import { goalLoopWorkflow } from "@/workflows/goal-loop";
import { appendEvent } from "@/lib/goals/event-log";

export const dynamic = "force-dynamic";

const TargetMetric = z.object({
  metric: z.enum([
    "impressions",
    "clicks",
    "ctr",
    "engagement_rate",
    "conversions",
  ]),
  target: z.number(),
  channel: z.string().nullable().optional(),
  window: z.enum(["7d", "30d", "90d"]).optional(),
});

const CreateGoal = z.object({
  summary: z.string().min(1).max(2_000),
  targetMetrics: z.array(TargetMetric).default([]),
  budgetCents: z.number().int().nonnegative().optional(),
  deadline: z.string().datetime().optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  campaignName: z.string().min(1).optional(),
  campaignSlug: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    await getRequestActor();
    const ctx = await getWorkspaceContext();
    const input = await parseJson(request, CreateGoal);
    const db = getDb();

    const slug =
      input.campaignSlug ?? `goal-${Date.now().toString(36)}`;
    const name = input.campaignName ?? input.summary.slice(0, 80);

    const inserted = await db
      .insert(schema.campaigns)
      .values({
        workspaceId: ctx.workspaceId,
        slug,
        name,
        status: "active",
        phase: "buildup",
        goalDefinition: { summary: input.summary },
        targetMetrics: input.targetMetrics,
        loopStatus: "planning",
        loopIteration: 0,
        budgetCents: input.budgetCents ?? null,
        deadline: input.deadline ? new Date(input.deadline) : null,
      })
      .returning({ id: schema.campaigns.id });
    const campaignId = inserted[0]!.id;

    await appendEvent({
      campaignId,
      iteration: 0,
      kind: "plan_drafted",
      stepKey: "goal-created",
      payload: {
        summary: input.summary,
        targetMetrics: input.targetMetrics,
      },
    });

    const run = await start(goalLoopWorkflow, [
      {
        campaignId,
        workspaceId: ctx.workspaceId,
        maxIterations: input.maxIterations,
      },
    ]);

    return Response.json(
      {
        campaignId,
        runId: run.runId,
        status: "started",
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(_request: Request) {
  try {
    await getRequestActor();
    const db = getDb();
    const rows = await db
      .select({
        id: schema.campaigns.id,
        slug: schema.campaigns.slug,
        name: schema.campaigns.name,
        loopStatus: schema.campaigns.loopStatus,
        loopIteration: schema.campaigns.loopIteration,
        budgetCents: schema.campaigns.budgetCents,
        costCentsSpent: schema.campaigns.costCentsSpent,
        deadline: schema.campaigns.deadline,
        lastIterationAt: schema.campaigns.lastIterationAt,
        goalDefinition: schema.campaigns.goalDefinition,
      })
      .from(schema.campaigns)
      .where(sql`${schema.campaigns.loopStatus} != 'idle'`);
    return Response.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
