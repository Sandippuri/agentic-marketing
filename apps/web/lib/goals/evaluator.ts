/**
 * Pure convergence evaluator for the goal loop.
 *
 * Given a campaign's target_metrics and observed outcomes (per-content per-
 * channel rollups from the outcomes table), decide whether the loop should
 * stop ('converged'), continue ('continue'), or halt due to budget/deadline
 * exceedance ('halted').
 *
 * Pure function — no DB / network. Easy to unit test.
 */

export type TargetMetric = {
  /** Metric name. Currently supports impressions | clicks | ctr | engagement_rate. */
  metric:
    | "impressions"
    | "clicks"
    | "ctr"
    | "engagement_rate"
    | "conversions";
  /** Required threshold (>= for impressions/clicks/conversions, >= for ctr/engagement). */
  target: number;
  /** Optional channel filter; when null, sums across channels. */
  channel?: string | null;
  /** Window to read from. */
  window?: "7d" | "30d" | "90d";
};

export type OutcomeSnapshot = {
  channel: string;
  window: "7d" | "30d" | "90d";
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  engagementRate: number;
};

export type EvaluatorInput = {
  campaign: {
    id: string;
    targetMetrics: TargetMetric[] | null;
    budgetCents: number | null;
    costCentsSpent: number;
    deadline: Date | null;
    loopIteration: number;
    maxIterations?: number;
  };
  outcomes: OutcomeSnapshot[];
  now?: Date;
};

export type EvaluatorVerdict =
  | { state: "continue"; reason: string }
  | { state: "converged"; reason: string }
  | { state: "halted"; reason: string };

const DEFAULT_MAX_ITERATIONS = 6;

export function evaluateConvergence(input: EvaluatorInput): EvaluatorVerdict {
  const now = input.now ?? new Date();
  const max = input.campaign.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  if (
    input.campaign.budgetCents != null &&
    input.campaign.costCentsSpent >= input.campaign.budgetCents
  ) {
    return { state: "halted", reason: "budget_exceeded" };
  }

  if (input.campaign.deadline && now >= input.campaign.deadline) {
    return { state: "halted", reason: "deadline_reached" };
  }

  if (input.campaign.loopIteration >= max) {
    return { state: "halted", reason: "max_iterations" };
  }

  const targets = input.campaign.targetMetrics ?? [];
  if (targets.length === 0) {
    return {
      state: "continue",
      reason: "no_targets_defined; running until budget/deadline/max_iterations",
    };
  }

  let allMet = true;
  const summary: string[] = [];
  for (const t of targets) {
    const slice = sliceForTarget(input.outcomes, t);
    const value = aggregate(slice, t.metric);
    const met = value >= t.target;
    summary.push(
      `${t.channel ?? "all"}/${t.metric}=${value.toFixed(3)} target=${t.target} ${met ? "✓" : "✗"}`,
    );
    if (!met) allMet = false;
  }
  if (allMet) {
    return { state: "converged", reason: `targets_met: ${summary.join(", ")}` };
  }
  return { state: "continue", reason: `targets_pending: ${summary.join(", ")}` };
}

function sliceForTarget(
  outcomes: OutcomeSnapshot[],
  t: TargetMetric,
): OutcomeSnapshot[] {
  const window = t.window ?? "7d";
  return outcomes.filter(
    (o) => o.window === window && (t.channel == null || o.channel === t.channel),
  );
}

function aggregate(
  slice: OutcomeSnapshot[],
  metric: TargetMetric["metric"],
): number {
  if (slice.length === 0) return 0;
  switch (metric) {
    case "impressions":
      return slice.reduce((s, o) => s + o.impressions, 0);
    case "clicks":
      return slice.reduce((s, o) => s + o.clicks, 0);
    case "conversions":
      return slice.reduce((s, o) => s + o.conversions, 0);
    case "ctr": {
      const totalImpressions = slice.reduce((s, o) => s + o.impressions, 0);
      const totalClicks = slice.reduce((s, o) => s + o.clicks, 0);
      return totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    }
    case "engagement_rate": {
      // Weighted by impressions when present; fall back to simple mean.
      const weighted = slice.reduce(
        (s, o) => s + o.engagementRate * Math.max(1, o.impressions),
        0,
      );
      const denom = slice.reduce(
        (s, o) => s + Math.max(1, o.impressions),
        0,
      );
      return denom > 0 ? weighted / denom : 0;
    }
    default:
      return 0;
  }
}
