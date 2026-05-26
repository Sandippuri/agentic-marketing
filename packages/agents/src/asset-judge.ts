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
import { getPrompt } from "./prompt-store";
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
  reason: z.string().optional().default(""),
});

export type CandidateScore = z.infer<typeof ScoreSchema> & {
  index: number;
  imageUrl: string;
};

export const JUDGE_PROMPT = `You are a senior creative reviewer. Score one generated
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
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

// Judge runs a tight rubric → tiny JSON; Sonnet is overkill. Haiku 4.5 is
// vision-capable, ~3-5× faster, and an order of magnitude cheaper, so the
// retry-once-on-reject path doesn't dominate latency or spend. Override per
// call by passing `model:` on RunJudgeInput.
export const JUDGE_DEFAULT_MODEL: LlmModel = "claude-haiku-4-5-20251001";

// Hard cap so a stalled vision request can't park a workflow step forever.
// 60s is well over normal vision latency (~3-8s on Haiku); anything beyond
// that is almost certainly a hung socket or provider outage — fail fast and
// let the retry-once path or catch-all reject handle it.
const JUDGE_REQUEST_TIMEOUT_MS = 60_000;

export async function runAssetJudge(
  input: RunJudgeInput,
): Promise<CandidateScore[]> {
  const model = input.model ?? JUDGE_DEFAULT_MODEL;
  const settled = await Promise.allSettled(
    input.candidates.map((c) => scoreOne(input.brief, c, model)),
  );

  const scores: CandidateScore[] = [];
  for (let i = 0; i < settled.length; i++) {
    const c = input.candidates[i]!;
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      const score = r.value;
      scores.push({ ...score, index: c.index, imageUrl: c.imageUrl });
      recordLlmUsage({
        agent: "asset-judge",
        workspaceId: input.workspaceId,
        model,
        threadRef: input.threadRef ?? undefined,
        jobId: input.jobId ?? null,
        workflowRunId: input.workflowRunId ?? null,
        usage: score._usage as Parameters<typeof recordLlmUsage>[0]["usage"],
      }).catch(() => {});
    } else {
      const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      log.warn({ err: err.message, index: c.index }, "asset-judge failed; rejecting candidate");
      scores.push({
        index: c.index,
        imageUrl: c.imageUrl,
        subject_specificity: 0,
        brand_fit: 0,
        composition: 0,
        originality: 0,
        on_message: 0,
        total: 0,
        verdict: "reject",
        reason: `judge_error: ${err.message}`,
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

  const systemPrompt = await getPrompt("asset_judge.system", JUDGE_PROMPT);
  const { text, usage } = await generateText({
    model: getLanguageModel(model),
    abortSignal: AbortSignal.timeout(JUDGE_REQUEST_TIMEOUT_MS),
    maxRetries: 2,
    system: systemPrompt,
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
