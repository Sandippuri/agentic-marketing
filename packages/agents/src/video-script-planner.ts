// LLM-driven script planner for multi-clip video generation.
//
// The video providers (Veo, Sora, Replicate) all cap a single generation at
// ~8 seconds. To produce longer concept-explainer clips we split the idea
// into 1–4 beats and chain them — each beat's last frame seeds the next
// beat's image-to-video input so motion + lighting carry through cuts.
//
// This module owns the *script* side of that flow. It is intentionally
// model-agnostic: the same beat list works for Veo, Sora, or any Replicate
// video model. The orchestrator (apps/web/lib/video-variant.ts) feeds each
// `promptForVeo` string into generateVideo() unchanged.
//
// One beat = one ~8s Veo / Sora / Replicate call. Beat count is bounded
// hard (1..4) so the planner can't accidentally bill 20 clips on a thin
// concept, but otherwise the planner is free to pick what the idea needs.

import { generateText } from "ai";
import pino from "pino";
import { getLanguageModel } from "./llm-registry";
import type { LlmModel } from "@marketing/shared-types";

const log = pino({ name: "video-script-planner" });

// Hard ceiling. The planner LLM is told to pick 1–MAX based on concept
// complexity, but we clamp the parsed output too — a hallucinated 8-beat
// script would cost ~8x as much Veo billing as a normal video.
export const MAX_BEATS = 4;
export const PER_BEAT_SECONDS = 8;

export type VideoBeat = {
  /** 1-indexed position in the final stitched video. */
  index: number;
  /** Full prompt for one ~8s clip — ready to hand to generateVideo(). */
  promptForVeo: string;
  /** Short human-readable label for logs / observability ("opening", "reveal"…). */
  motionDescription: string;
};

export type VideoScript = {
  totalSec: number;
  beats: VideoBeat[];
  /** Why the planner picked this beat count. Surfaced in logs only. */
  reasoning: string;
};

export type PlanVideoScriptInput = {
  /** The post title or a one-line summary of what the video should explain. */
  subject: string;
  /** Art-director concept summary if one exists (richer than `subject`). */
  conceptSummary?: string | null;
  /** Motion fields from VisualConceptBrief, if present. */
  motion?: {
    opening_state?: string | null;
    reveal_beat?: string | null;
    settling_state?: string | null;
    camera?: string | null;
  } | null;
  /** Brand-prompt prefix — prepended to every beat so each clip honors brand. */
  brandPrefix?: string;
  /** Style notes from the brief. */
  styleNotes?: string | null;
  /** Banned elements from the brief. */
  bannedElements?: string[] | null;
  /** First-frame marker pulled from the post body, if any. */
  firstImageMarker?: string | null;
  /** Whether clip 1 will be image-to-video (i.e. an existing still exists). */
  hasFirstFrame: boolean;
  /** LLM to use for planning. Defaults to the project default. */
  model?: LlmModel;
};

/**
 * Plan a multi-clip video script. The LLM decides how many beats the
 * concept needs (1–MAX_BEATS) and produces a self-contained Veo-style
 * prompt for each one. Each beat must START where the previous one
 * SETTLED so the stitched result reads as one continuous shot.
 */
export async function planVideoScript(
  input: PlanVideoScriptInput,
): Promise<VideoScript> {
  const subject = input.subject.slice(0, 280).trim();
  const concept = (input.conceptSummary ?? input.firstImageMarker ?? subject)
    .slice(0, 480)
    .trim();

  const motionLines: string[] = [];
  if (input.motion?.opening_state)
    motionLines.push(`- opening: ${input.motion.opening_state}`);
  if (input.motion?.reveal_beat)
    motionLines.push(`- reveal: ${input.motion.reveal_beat}`);
  if (input.motion?.settling_state)
    motionLines.push(`- settling: ${input.motion.settling_state}`);
  if (input.motion?.camera) motionLines.push(`- camera: ${input.motion.camera}`);
  const motionBlock =
    motionLines.length > 0
      ? `\n# Director motion notes\n${motionLines.join("\n")}\n`
      : "";

  const styleLine = input.styleNotes ? `\n# Style notes\n${input.styleNotes}\n` : "";
  const bannedLine =
    input.bannedElements && input.bannedElements.length > 0
      ? `\n# Avoid\n${input.bannedElements.slice(0, 10).join(", ")}\n`
      : "";

  const i2vLine = input.hasFirstFrame
    ? "Clip 1 will start from an existing still (image-to-video). Its prompt MUST animate FROM that composition — do not re-stage."
    : "Clip 1 has no first frame. Its prompt should open on a clean establishing composition.";

  const system =
    "You are a video director planning a short concept-explainer clip for a marketing post. " +
    `Each clip provider can only generate ${PER_BEAT_SECONDS}-second segments, so you split the idea ` +
    `into ${1}–${MAX_BEATS} beats. ` +
    "Each beat is one ~8s clip; the beats will be stitched into one continuous video where each beat's last frame becomes the next beat's first frame. " +
    "Pick the SMALLEST beat count that lets the concept land. A single 8s beat is fine if the idea is simple; only escalate when the idea genuinely has multiple acts. " +
    "Return STRICT JSON with this shape:\n" +
    `{ "reasoning": string, "beats": [{ "motionDescription": string, "promptForVeo": string }, ...] }\n` +
    "No code fences, no commentary outside the JSON. Each promptForVeo must be a self-contained ~8s video prompt " +
    "(describing composition, what happens in seconds 0–2 / 2–6 / 6–8, camera move, lighting). " +
    "Make sure beat N+1's opening matches beat N's settling — the cut must be invisible.";

  const userMsg =
    `# Subject\n${subject}\n\n` +
    `# Concept to make legible through motion\n${concept}\n` +
    motionBlock +
    styleLine +
    bannedLine +
    `\n# Constraints\n- ${i2vLine}\n` +
    `- Each beat = ${PER_BEAT_SECONDS}s. Beat count: 1 to ${MAX_BEATS}.\n` +
    "- No on-screen text, no logos, no captions, no watermarks.\n" +
    "- Avoid: generic particle drifts, abstract glowing blobs, rainbow gradients, floating cubes, wireframe globes.\n" +
    "Output only the JSON object.";

  let raw = "";
  try {
    const { text } = await generateText({
      model: getLanguageModel(input.model),
      abortSignal: AbortSignal.timeout(60_000),
      maxRetries: 2,
      system,
      prompt: userMsg,
    });
    raw = text;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "planner LLM call failed; falling back to single-beat default",
    );
    return fallbackScript(input);
  }

  const parsed = parseScriptJson(raw);
  if (!parsed || parsed.beats.length === 0) {
    log.warn({ raw: raw.slice(0, 240) }, "planner JSON parse failed; using fallback");
    return fallbackScript(input);
  }

  // Apply the brand prefix to each beat AFTER parsing — keeps the planner
  // prompt clean and ensures the prefix isn't lost to JSON escaping mishaps.
  const beats: VideoBeat[] = parsed.beats
    .slice(0, MAX_BEATS)
    .map((b, i) => ({
      index: i + 1,
      motionDescription: b.motionDescription.slice(0, 120),
      promptForVeo: input.brandPrefix
        ? `${input.brandPrefix}${b.promptForVeo}`
        : b.promptForVeo,
    }));

  const script: VideoScript = {
    totalSec: beats.length * PER_BEAT_SECONDS,
    beats,
    reasoning: parsed.reasoning.slice(0, 240),
  };

  log.info(
    {
      beatCount: beats.length,
      totalSec: script.totalSec,
      reasoning: script.reasoning,
    },
    "video script planned",
  );
  return script;
}

// Last-resort 1-beat script when the planner LLM fails or returns garbage.
// Mirrors the prompt shape the old single-clip path used so callers don't
// see a quality drop just because the planner had a bad day.
function fallbackScript(input: PlanVideoScriptInput): VideoScript {
  const subject = input.subject.slice(0, 200).trim();
  const concept = (input.conceptSummary ?? input.firstImageMarker ?? subject)
    .slice(0, 320)
    .trim();
  const anchor = input.hasFirstFrame
    ? "Begin from the provided first frame and animate FROM that exact composition — preserve the existing color, lighting, and element placement; do not re-stage the scene."
    : "Open on a clean establishing composition that mirrors a poster still.";
  const beatPrompt =
    `An ~8 second concept-explainer clip that visualizes: ${subject}. ` +
    `Visual concept the clip must make clear: ${concept}. ` +
    `${anchor} ` +
    "Beat 1 (0-2s): the scene settles; key elements animate in subtly. " +
    "Beat 2 (2-6s): the core idea is revealed through motion. " +
    "Beat 3 (6-8s): motion eases out; the frame settles on a clean final composition. " +
    "Camera: a single intentional move (gentle push-in, slow orbit, or smooth parallax) — no jump cuts, no shaky-cam. " +
    "Style: brand-clean palette, subtle film grain, soft volumetric light. No on-screen text, no logos.";
  return {
    totalSec: PER_BEAT_SECONDS,
    beats: [
      {
        index: 1,
        motionDescription: "single-beat fallback",
        promptForVeo: input.brandPrefix
          ? `${input.brandPrefix}${beatPrompt}`
          : beatPrompt,
      },
    ],
    reasoning: "fallback after planner LLM failure",
  };
}

function parseScriptJson(
  text: string,
): { reasoning: string; beats: Array<{ motionDescription: string; promptForVeo: string }> } | null {
  // Strip the most common markdown fences before parsing.
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.beats)) return null;
  const beats: Array<{ motionDescription: string; promptForVeo: string }> = [];
  for (const b of r.beats) {
    if (!b || typeof b !== "object") continue;
    const bb = b as Record<string, unknown>;
    const promptForVeo =
      typeof bb.promptForVeo === "string" && bb.promptForVeo.trim()
        ? bb.promptForVeo.trim()
        : null;
    if (!promptForVeo) continue;
    const motionDescription =
      typeof bb.motionDescription === "string" && bb.motionDescription.trim()
        ? bb.motionDescription.trim()
        : `beat ${beats.length + 1}`;
    beats.push({ motionDescription, promptForVeo });
  }
  if (beats.length === 0) return null;
  const reasoning = typeof r.reasoning === "string" ? r.reasoning : "";
  return { reasoning, beats };
}
