/**
 * Vision-LLM judge for generated assets.
 *
 * Given a concept brief and a candidate's URL/bytes, score it against the
 * brief on five axes (subject specificity, brand fit, composition,
 * originality, on-message). Reject candidates that score below threshold so
 * the asset pipeline either picks a passing sibling or regenerates with a
 * tightened prompt.
 *
 * Stops "generic floating cube" outputs from making it to approval cards.
 */
import { generateText } from "ai";
import { z } from "zod";
import pino from "pino";
import type { LlmModel } from "@marketing/shared-types";
import { getLanguageModel } from "./llm-registry";
import { recordLlmUsage } from "./usage";
import type { VisualConceptBrief } from "./sub-agents/art-director";

const log = pino({ name: "asset-judge" });

export type JudgeCandidate = {
  index: number;
  /** Either a public URL or a data: URL (from inline bytes). */
  imageUrl: string;
  prompt: string;
};

const ScoreSchema = z.object({
  subject_specificity: z.number().min(0).max(5),
  brand_fit: z.number().min(0).max(5),
  composition: z.number().min(0).max(5),
  originality: z.number().min(0).max(5),
  on_message: z.number().min(0).max(5),
  total: z.number().optional(),
  verdict: z.enum(["accept", "reject"]),
  reason: z.string(),
});

export type CandidateScore = z.infer<typeof ScoreSchema> & {
  index: number;
  imageUrl: string;
};

const JUDGE_PROMPT = `You are a senior creative reviewer. Score one generated
image against the visual concept brief on a 0-5 scale across five axes:

1. subject_specificity — does the image show the SPECIFIC subjects named
   in the brief, not generic stand-ins (anonymous cubes, generic crypto
   coins, abstract shapes)?
2. brand_fit            — does the palette / mood / typographic feel match
   the brand notes?
3. composition          — does composition / focal point match the brief?
4. originality          — would a senior designer say this looks like every
   other AI marketing image, or does it have specificity?
5. on_message           — does the image reinforce the message, or is it
   just decorative?

Reject (verdict=reject) if subject_specificity < 3 OR on_message < 3 OR
total < 14. Otherwise verdict=accept.

Output JSON only — no fence, no commentary.`;

export type RunJudgeInput = {
  brief: VisualConceptBrief;
  candidates: JudgeCandidate[];
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

export async function runAssetJudge(
  input: RunJudgeInput,
): Promise<CandidateScore[]> {
  const scores: CandidateScore[] = [];
  for (const c of input.candidates) {
    try {
      const score = await scoreOne(input.brief, c, input.model);
      scores.push({ ...score, index: c.index, imageUrl: c.imageUrl });
      await recordLlmUsage({
        agent: "asset-judge",
        model: input.model,
        threadRef: input.threadRef ?? undefined,
        jobId: input.jobId ?? null,
        workflowRunId: input.workflowRunId ?? null,
        usage: score._usage as Parameters<typeof recordLlmUsage>[0]["usage"],
      });
    } catch (err) {
      log.warn({ err: (err as Error).message, index: c.index }, "asset-judge failed; treating as accept");
      scores.push({
        index: c.index,
        imageUrl: c.imageUrl,
        subject_specificity: 3,
        brand_fit: 3,
        composition: 3,
        originality: 3,
        on_message: 3,
        total: 15,
        verdict: "accept",
        reason: `judge_error: ${(err as Error).message}`,
      });
    }
  }
  return scores;
}

async function scoreOne(
  brief: VisualConceptBrief,
  candidate: JudgeCandidate,
  model?: LlmModel,
): Promise<z.infer<typeof ScoreSchema> & { _usage?: unknown }> {
  const briefSummary = JSON.stringify(
    {
      concept_summary: brief.concept_summary,
      focal_point: brief.focal_point,
      real_subjects: brief.real_subjects,
      style_notes: brief.style_notes,
      banned_elements: brief.banned_elements,
    },
    null,
    2,
  );

  const { text, usage } = await generateText({
    model: getLanguageModel(model),
    system: JUDGE_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `# Visual concept brief\n${briefSummary}\n\n# Candidate prompt\n${candidate.prompt.slice(0, 1_000)}\n\n# Candidate image\nReview the image attached. Output JSON.`,
          },
          { type: "image", image: candidate.imageUrl },
        ],
      },
    ],
  });

  const parsed = ScoreSchema.parse(JSON.parse(stripFence(text)));
  const total =
    parsed.subject_specificity +
    parsed.brand_fit +
    parsed.composition +
    parsed.originality +
    parsed.on_message;
  return { ...parsed, total, _usage: usage };
}

function stripFence(text: string): string {
  const m = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  return m && m[1] ? m[1] : text.trim();
}

export function pickWinner(scores: CandidateScore[]): CandidateScore | null {
  const accepted = scores.filter((s) => s.verdict === "accept");
  const pool = accepted.length > 0 ? accepted : scores;
  if (pool.length === 0) return null;
  return pool.reduce((best, s) => ((s.total ?? 0) > (best.total ?? 0) ? s : best));
}
