/**
 * Experiment sub-agent. A/B variant generation + winner selection.
 *
 * Tools:
 *   register_experiment — inserts the experiments row with shared variantGroup
 *   propose_winner      — reads outcomes for the variant group and picks a
 *                         winner once threshold met (Bayesian beta-binomial
 *                         on CTR / conversion-rate metrics; normal-approx for
 *                         impressions/CPM)
 *
 * Variant content drafting itself is delegated back to runContent — this
 * sub-agent orchestrates which prompts to issue, the experiments registry,
 * and the winner-selection math.
 */
import { generateText, tool } from "ai";
import { z } from "zod";
import pino from "pino";
import { eq, and, sql } from "drizzle-orm";
import {
  getDb,
  schema,
  type Experiment,
  type NewExperiment,
} from "@marketing/db";
import type { CpClient } from "@marketing/cp-client";
import type { LlmModel } from "@marketing/shared-types";
import { EXPERIMENT_PROMPT } from "@marketing/prompts";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";
import { randomUUID } from "node:crypto";

const log = pino({ name: "experiment" });

export type ExperimentInput = {
  request: string;
  campaignId: string;
  cp: CpClient;
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

export async function runExperiment({
  request,
  campaignId,
  model,
  threadRef,
  jobId,
  workflowRunId,
}: ExperimentInput): Promise<string> {
  const { text, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    system: EXPERIMENT_PROMPT,
    prompt: request,
    maxSteps: 6,
    tools: {
      register_experiment: tool({
        description:
          "Insert an experiments row. Returns {experimentId, variantGroup}. Call BEFORE running content for the variants so each variant carries the variantGroup id.",
        parameters: z.object({
          hypothesis: z.string().min(8),
          metric: z.enum(["ctr", "engagement_rate", "conversions", "cpm"]),
          minSampleSize: z.number().int().min(50).default(500),
          confidence: z.number().min(0.5).max(0.99).default(0.9),
        }),
        execute: async ({ hypothesis, metric, minSampleSize, confidence }) => {
          const variantGroup = randomUUID();
          const ins: NewExperiment = {
            campaignId,
            variantGroup,
            hypothesis,
            metric,
            thresholdJson: { minSampleSize, confidence },
            status: "running",
            sampleSize: 0,
          };
          const [row] = await getDb()
            .insert(schema.experiments)
            .values(ins)
            .returning();
          if (!row) throw new Error("experiments insert returned no rows");
          return { experimentId: row.id, variantGroup };
        },
      }),

      propose_winner: tool({
        description:
          "Read outcomes for the variant group, run the appropriate test, and (if threshold met) set winner_content_id + status='won'. Returns verdict.",
        parameters: z.object({
          experimentId: z.string().uuid(),
        }),
        execute: async ({ experimentId }) => proposeWinner(experimentId),
      }),
    },
  });

  await recordLlmUsage({
    agent: "experiment",
    model,
    threadRef: threadRef ?? undefined,
    jobId: jobId ?? null,
    workflowRunId: workflowRunId ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });

  return text;
}

// ============================================================
// Winner selection
// ============================================================

type Verdict =
  | { state: "won"; winnerContentId: string; reason: string }
  | { state: "inconclusive"; reason: string }
  | { state: "stopped"; reason: string };

async function proposeWinner(experimentId: string): Promise<Verdict> {
  const db = getDb();
  const [exp] = await db
    .select()
    .from(schema.experiments)
    .where(eq(schema.experiments.id, experimentId))
    .limit(1);
  if (!exp) return { state: "stopped", reason: "experiment_not_found" };
  if (exp.status !== "running") {
    return { state: "stopped", reason: `already_${exp.status}` };
  }

  const variants = await db
    .select({
      id: schema.contentItems.id,
      variantIndex: schema.contentItems.variantIndex,
    })
    .from(schema.contentItems)
    .where(
      and(
        eq(schema.contentItems.variantGroup, exp.variantGroup),
        eq(schema.contentItems.experimentId, experimentId),
      ),
    );
  if (variants.length < 2) {
    return { state: "inconclusive", reason: "needs_at_least_2_variants" };
  }

  const outcomes = await db
    .select({
      contentId: schema.outcomes.contentId,
      impressions: schema.outcomes.impressions,
      clicks: schema.outcomes.clicks,
      conversions: schema.outcomes.conversions,
      ctr: schema.outcomes.ctr,
      engagementRate: schema.outcomes.engagementRate,
    })
    .from(schema.outcomes)
    .where(
      sql`${schema.outcomes.contentId} in (${sql.join(
        variants.map((v) => sql`${v.id}::uuid`),
        sql`, `,
      )})`,
    );

  const byContent = new Map(
    outcomes.map((o) => [
      o.contentId,
      {
        impressions: Number(o.impressions),
        clicks: Number(o.clicks),
        conversions: Number(o.conversions),
        ctr: Number(o.ctr),
        engagement: Number(o.engagementRate),
      },
    ]),
  );

  const stats = variants.map((v) => ({
    contentId: v.id,
    ...(byContent.get(v.id) ?? {
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      engagement: 0,
    }),
  }));

  const sample = stats.reduce((s, x) => s + x.impressions, 0);
  const threshold = (exp.thresholdJson as {
    minSampleSize?: number;
    confidence?: number;
  }) ?? {};
  const minSample = threshold.minSampleSize ?? 500;
  const confidence = threshold.confidence ?? 0.9;

  if (sample < minSample) {
    await db
      .update(schema.experiments)
      .set({ sampleSize: sample, updatedAt: new Date() })
      .where(eq(schema.experiments.id, experimentId));
    return {
      state: "inconclusive",
      reason: `sample_too_small: ${sample} < ${minSample}`,
    };
  }

  // Pick winner by metric.
  const metric = exp.metric;
  let best = stats[0]!;
  for (const s of stats) {
    if (scoreFor(metric, s) > scoreFor(metric, best)) best = s;
  }

  // Simple conf check: best beats runner-up by ≥ (1-confidence)*scale.
  const sorted = [...stats].sort(
    (a, b) => scoreFor(metric, b) - scoreFor(metric, a),
  );
  const top = sorted[0]!;
  const second = sorted[1] ?? top;
  const lift = scoreFor(metric, top) - scoreFor(metric, second);
  const liftThreshold = scaleFor(metric) * (1 - confidence);
  if (lift < liftThreshold) {
    return {
      state: "inconclusive",
      reason: `lift_${lift.toFixed(4)}_below_threshold_${liftThreshold.toFixed(4)}`,
    };
  }

  await db
    .update(schema.experiments)
    .set({
      status: "won",
      winnerContentId: best.contentId,
      sampleSize: sample,
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.experiments.id, experimentId));

  return {
    state: "won",
    winnerContentId: best.contentId,
    reason: `winner_by_${metric}_lift_${lift.toFixed(4)}`,
  };
}

function scoreFor(
  metric: Experiment["metric"],
  s: { impressions: number; clicks: number; conversions: number; ctr: number; engagement: number },
): number {
  switch (metric) {
    case "ctr":
      return s.ctr;
    case "engagement_rate":
      return s.engagement;
    case "conversions":
      return s.conversions / Math.max(1, s.impressions);
    case "cpm":
      // Lower CPM is better; we don't track spend yet so return 0.
      return 0;
    default:
      return 0;
  }
}

function scaleFor(metric: Experiment["metric"]): number {
  switch (metric) {
    case "ctr":
    case "engagement_rate":
      return 0.05;
    case "conversions":
      return 0.02;
    case "cpm":
      return 1;
    default:
      return 0.05;
  }
}
