/**
 * Budget guard for goal-driven campaigns.
 *
 * Goal-loop campaigns carry a `budget_cents` cap. This helper recomputes
 * `cost_cents_spent` from the authoritative source (sum of llm_usage.cost_usd
 * for every workflow_run scoped to the campaign), patches it onto the
 * campaigns row, and returns whether the loop should continue.
 *
 * Called at the top of every goal-loop iteration. Cheap pure SQL — no LLM,
 * no network beyond Postgres.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";

export type BudgetVerdict =
  | { state: "ok"; spentCents: number; budgetCents: number | null; remainingCents: number | null }
  | {
      state: "exceeded";
      spentCents: number;
      budgetCents: number;
      remainingCents: 0;
      reason: "budget_exceeded";
    }
  | { state: "no_campaign" };

const USD_TO_CENTS = 100;

export async function assertWithinBudget(
  campaignId: string,
): Promise<BudgetVerdict> {
  const db = getDb();
  const [row] = await db
    .select({
      id: schema.campaigns.id,
      budgetCents: schema.campaigns.budgetCents,
      costCentsSpent: schema.campaigns.costCentsSpent,
    })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId))
    .limit(1);
  if (!row) return { state: "no_campaign" };

  // Recompute spent from llm_usage joined through workflow_runs. Authoritative
  // even when a previous iteration crashed before patching the rollup column.
  const [agg] = await db
    .select({
      costUsd: sql<number>`coalesce(sum(${schema.llmUsage.costUsd}), 0)::float8`,
    })
    .from(schema.llmUsage)
    .innerJoin(
      schema.workflowRuns,
      eq(schema.llmUsage.workflowRunId, schema.workflowRuns.id),
    )
    .where(eq(schema.workflowRuns.campaignId, campaignId));

  const spentCents = Math.round((agg?.costUsd ?? 0) * USD_TO_CENTS);
  if (spentCents !== row.costCentsSpent) {
    await db
      .update(schema.campaigns)
      .set({ costCentsSpent: spentCents, updatedAt: new Date() })
      .where(eq(schema.campaigns.id, campaignId));
  }

  if (row.budgetCents == null) {
    return { state: "ok", spentCents, budgetCents: null, remainingCents: null };
  }
  if (spentCents >= row.budgetCents) {
    return {
      state: "exceeded",
      spentCents,
      budgetCents: row.budgetCents,
      remainingCents: 0,
      reason: "budget_exceeded",
    };
  }
  return {
    state: "ok",
    spentCents,
    budgetCents: row.budgetCents,
    remainingCents: row.budgetCents - spentCents,
  };
}
