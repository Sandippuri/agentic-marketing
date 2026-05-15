/**
 * Goal-loop event log.
 *
 * Each meaningful step in the loop appends a goal_events row keyed by
 * (campaign_id, iteration, step_key) — the partial-unique index from
 * migration 0016 enforces idempotency. The loop's step.do() wrappers can
 * call appendEvent freely on retry; second writes return the prior row.
 *
 * On crash + restart, replayEvents reconstructs the loop's progress so the
 * next iteration knows what's already done.
 */
import { eq, and, desc } from "drizzle-orm";
import {
  getDb,
  schema,
  type GoalEvent,
} from "@marketing/db";

export type GoalEventKind =
  | "plan_drafted"
  | "fanout_started"
  | "approval_requested"
  | "approval_resolved"
  | "published"
  | "outcome_observed"
  | "reevaluated"
  | "converged"
  | "halted"
  | "error";

export type AppendEventInput = {
  campaignId: string;
  iteration: number;
  kind: GoalEventKind;
  /** Idempotency key. When set + already exists, returns the prior row. */
  stepKey?: string;
  payload?: Record<string, unknown>;
  /** Workspace scope. When omitted, looked up from the campaign row. */
  workspaceId?: string;
};

export async function appendEvent(input: AppendEventInput): Promise<GoalEvent> {
  const db = getDb();
  if (input.stepKey) {
    const existing = await db
      .select()
      .from(schema.goalEvents)
      .where(
        and(
          eq(schema.goalEvents.campaignId, input.campaignId),
          eq(schema.goalEvents.iteration, input.iteration),
          eq(schema.goalEvents.stepKey, input.stepKey),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
  }
  let workspaceId = input.workspaceId ?? null;
  if (!workspaceId) {
    const [campaign] = await db
      .select({ workspaceId: schema.campaigns.workspaceId })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, input.campaignId))
      .limit(1);
    if (!campaign) throw new Error(`campaign not found: ${input.campaignId}`);
    workspaceId = campaign.workspaceId;
  }
  const [row] = await db
    .insert(schema.goalEvents)
    .values({
      workspaceId,
      campaignId: input.campaignId,
      iteration: input.iteration,
      kind: input.kind,
      stepKey: input.stepKey ?? null,
      payload: input.payload ?? {},
    })
    .returning();
  if (!row) throw new Error("goal_events insert returned no rows");
  return row;
}

export async function listEvents(
  campaignId: string,
  opts: { iteration?: number; limit?: number } = {},
): Promise<GoalEvent[]> {
  const db = getDb();
  const conds = [eq(schema.goalEvents.campaignId, campaignId)];
  if (typeof opts.iteration === "number") {
    conds.push(eq(schema.goalEvents.iteration, opts.iteration));
  }
  return db
    .select()
    .from(schema.goalEvents)
    .where(and(...conds))
    .orderBy(desc(schema.goalEvents.ts))
    .limit(opts.limit ?? 200);
}

/**
 * Look up a previously-recorded event by step key. The goal-loop calls this
 * at the top of each step.do() to avoid re-doing work on resume-from-crash.
 */
export async function findByStepKey(
  campaignId: string,
  iteration: number,
  stepKey: string,
): Promise<GoalEvent | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.goalEvents)
    .where(
      and(
        eq(schema.goalEvents.campaignId, campaignId),
        eq(schema.goalEvents.iteration, iteration),
        eq(schema.goalEvents.stepKey, stepKey),
      ),
    )
    .limit(1);
  return row ?? null;
}
