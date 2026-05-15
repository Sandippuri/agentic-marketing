/**
 * Art Director sub-agent.
 *
 * Two modes:
 *
 *   1. REFINER (preferred, post-0029) — when the Content agent has emitted an
 *      `imageBrief` on the content_item, the AD skips the LLM concept-
 *      synthesis call entirely. It composes the VisualConceptBrief
 *      deterministically from imageBrief + the campaign's visualIdentity +
 *      KB visual_references. This is the cheap, on-target path.
 *
 *   2. LEGACY (fallback) — when imageBrief is missing (older content rows,
 *      cron paths that didn't go through the new content tool), the AD runs
 *      the original LLM-driven synthesis: read the body, search KB, ask the
 *      model to invent a concept. Kept for backward compatibility.
 *
 * Output is the same VisualConceptBrief in both modes — concept-to-prompt.ts
 * translates it into the provider-ready image-gen prompt downstream.
 */
import { generateText } from "ai";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import type { LlmModel } from "@marketing/shared-types";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";
import { kbSearch, type KbSearchHit } from "../kb";
import { findBrandGuidance } from "../brand-guidance";
import type { ImageBrief } from "./content";
import type { VisualIdentity } from "./strategist";

const log = pino({ name: "art-director" });

export type ArtDirectorInput = {
  /** What the content is about (the message / angle / feature). */
  request: string;
  /** Workspace whose KB and brand memory the AD may read. PR 4 cross-tenant safety. */
  workspaceId: string;
  /** Optional content body — gives the AD context for what the image must reinforce. */
  contentBody?: string;
  /** Channel hint affects composition/aspect (e.g. linkedin = square poster). */
  channel?: string;
  campaignId?: string;
  cp: CpClient;
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  /**
   * Per-post image direction emitted by the Content agent at draft time.
   * When present, AD runs in REFINER mode — no LLM concept-synthesis call.
   */
  imageBrief?: ImageBrief | null;
  /**
   * Campaign-level visual identity from the Strategist. Used for cross-post
   * consistency in REFINER mode.
   */
  visualIdentity?: VisualIdentity | null;
};

/**
 * Motion direction the brief carries forward to video generation. Each beat
 * names a concrete state, not vague vibes — Veo follows time-coded direction
 * far more reliably than "smooth cinematic camera".
 */
export type VisualMotionBrief = {
  /** What the scene looks like in beat 1 (0–2s). The still as a starting point. */
  opening_state: string;
  /** The transformation in beat 2 (2–6s) — the visual idea revealed through motion. */
  reveal_beat: string;
  /** Where it lands in beat 3 (6–8s) — a clean final composition. */
  settling_state: string;
  /** One intentional move: "slow push-in", "gentle orbit", "smooth parallax". */
  camera: string;
};

/**
 * Structured text slots an asset template renders deterministically (instead
 * of letting the image model embed text inside the generated picture). The
 * AD authors poster-length copy here — the raw content title is often
 * blog-length and not suitable as a headline.
 */
export type VisualTextSlots = {
  /** Small uppercase kicker — a category, product, or theme tag. ≤24 chars. */
  eyebrow: string;
  /** Poster-length headline (≤8 words / ~50 chars) that reads in 2 seconds. */
  headline: string;
  /** Optional dek / subline that contextualizes the headline. ≤120 chars. */
  subline: string;
  /** Optional one-line call to action ("Read more", "Try it free"). ≤24 chars. */
  cta: string;
};

export type VisualConceptBrief = {
  /** One-sentence summary the LLM judge can compare candidates against. */
  concept_summary: string;
  /** Composition + camera framing notes ("isometric 3/4 view, hero shot of bridge UI"). */
  composition: string;
  /** What the eye lands on first ("the cross-chain transaction approval modal"). */
  focal_point: string;
  /** Real subjects that MUST appear (product UI elements, real diagrams, etc). */
  real_subjects: string[];
  /** KB documentIds whose metadata.image_url should be passed to image-gen as imageInput. */
  reference_image_urls: string[];
  /** Stylistic notes ("clean editorial, restrained palette, soft cool light"). */
  style_notes: string;
  /** What this image must NOT be — fed to negative prompts. */
  banned_elements: string[];
  /** Time-coded motion direction consumed by the video generator. */
  motion: VisualMotionBrief;
  /** Deterministic text slots an asset template renders onto the canvas. */
  slots: VisualTextSlots;
  /** Provenance — for debugging + the asset-judge's tie-back to KB. */
  references_from_kb: Array<{
    documentId: string;
    title: string;
    similarity: number;
  }>;
};

/**
 * Default banned aesthetics — the things every "AI-looking" generation slips
 * into when given only colors. Caller can extend.
 */
export const DEFAULT_BANNED_AESTHETICS = [
  "generic abstract shapes",
  "anonymous floating geometric cubes",
  "stock 3D crypto coin",
  "generic Ethereum diamond",
  "rainbow gradients on black",
  "wireframe globe",
  "robotic hands typing",
  "person staring at futuristic UI from behind",
  "neon city skyline",
  "matrix code rain",
];

const MotionSchema = z.object({
  opening_state: z.string().default(""),
  reveal_beat: z.string().default(""),
  settling_state: z.string().default(""),
  camera: z.string().default(""),
});

const SlotsSchema = z.object({
  eyebrow: z.string().max(40).default(""),
  headline: z.string().max(80).default(""),
  subline: z.string().max(160).default(""),
  cta: z.string().max(40).default(""),
});

const ConceptSchema = z.object({
  concept_summary: z.string().min(8),
  composition: z.string().min(4),
  focal_point: z.string().min(4),
  real_subjects: z.array(z.string()).default([]),
  reference_image_urls: z.array(z.string().url()).default([]),
  style_notes: z.string().default(""),
  banned_elements: z.array(z.string()).default([]),
  motion: MotionSchema.default({
    opening_state: "",
    reveal_beat: "",
    settling_state: "",
    camera: "",
  }),
  slots: SlotsSchema.default({
    eyebrow: "",
    headline: "",
    subline: "",
    cta: "",
  }),
});

const ART_DIRECTOR_PROMPT = `You are the Art Director for a product-driven marketing team.
Your job is to design ONE specific visual concept for a piece of content. The
piece will then be generated by an image model with reference image
conditioning.

Rules of the road:
- The concept MUST name the actual product feature or message — never
  abstract / generic.
- Pull real subjects (product UI, real diagrams, signature motifs) that
  the image model can ground itself in.
- When a KB reference image fits, ALWAYS include its url in
  reference_image_urls. The image model uses these as visual conditioning,
  not just inspiration.
- Style notes describe lighting / mood / palette, NOT subject. Subjects go
  in real_subjects.
- Banned elements MUST include the failure modes you'd reject if this
  came back from a designer — the things that would make this look like
  every other AI-generated post.
- Motion: describe a concrete 8-second arc that EXPLAINS the concept
  through movement, not decoration. opening_state mirrors the still;
  reveal_beat is what changes (flows converge, layers stack, paths
  branch, before/after toggles); settling_state is the final hero
  composition. camera is ONE intentional move — never multiple cuts.
- Slots: author POSTER-LENGTH copy here. The raw content title is often
  blog-length; condense it. headline is ≤8 words / ≤50 chars and reads
  in 2 seconds. eyebrow is a short category/product tag (≤24 chars).
  subline is optional dek that adds context (≤120 chars). cta is
  optional (≤24 chars). Leave empty strings rather than padding.
- Output ONLY valid JSON. No markdown fence, no commentary.`;

export async function runArtDirector(
  input: ArtDirectorInput,
): Promise<VisualConceptBrief> {
  // REFINER mode: when the Content agent has named the literal subject in
  // imageBrief, we don't need an LLM to invent one. Compose the brief
  // deterministically — saves ~$0.05/post and keeps direction tight.
  if (input.imageBrief) {
    return refineFromImageBrief(input, input.imageBrief);
  }
  return runArtDirectorLegacy(input);
}

/**
 * Compose a VisualConceptBrief from the Content agent's imageBrief + the
 * campaign's visualIdentity + KB visual references. No LLM call — pure
 * data transform plus one cheap embedding lookup.
 */
async function refineFromImageBrief(
  input: ArtDirectorInput,
  imageBrief: ImageBrief,
): Promise<VisualConceptBrief> {
  const visualHits = await kbSearch({
    query: imageBrief.subject,
    workspaceId: input.workspaceId,
    collectionKinds: ["visual_reference"],
    campaignId: input.campaignId,
    k: 4,
  }).catch(() => [] as KbSearchHit[]);

  const referenceUrls = visualHits
    .map((h) => extractImageUrl(h))
    .filter((u): u is string => Boolean(u));

  const identity = input.visualIdentity ?? null;

  const styleNotes = [
    identity?.color_mood,
    identity?.art_style,
    imageBrief.mood ? `mood: ${imageBrief.mood}` : null,
    identity?.recurring_motifs.length
      ? `recurring motifs: ${identity.recurring_motifs.join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join(". ");

  // Banned elements: the Content agent's must_not_show + the campaign's
  // banned_aesthetics + the project-wide AI-slop defaults. Deduped.
  const banned = uniq([
    ...DEFAULT_BANNED_AESTHETICS,
    ...(identity?.banned_aesthetics ?? []),
    ...imageBrief.must_not_show,
  ]);

  const focal = imageBrief.subject;
  const composition = compositionLabel(imageBrief.composition);

  // Slots: the model renders overlay text natively (post-0029 we dropped the
  // template renderer). headline = imageBrief.overlay_text when set.
  const slots = {
    eyebrow: "",
    headline: (imageBrief.overlay_text ?? "").slice(0, 80),
    subline: "",
    cta: "",
  };

  return {
    concept_summary: imageBrief.subject.slice(0, 240),
    composition,
    focal_point: focal,
    real_subjects: uniq(imageBrief.must_show),
    reference_image_urls: uniq(referenceUrls),
    style_notes: styleNotes,
    banned_elements: banned,
    motion: {
      // Image-first path; video kickoff falls back to body-driven motion if
      // it ever needs it. Empty here is fine — Veo path reads the brief
      // differently and will degrade gracefully.
      opening_state: "",
      reveal_beat: "",
      settling_state: "",
      camera: "",
    },
    slots,
    references_from_kb: visualHits.map((h) => ({
      documentId: h.documentId,
      title: h.documentTitle,
      similarity: h.similarity,
    })),
  };
}

function compositionLabel(c: ImageBrief["composition"]): string {
  switch (c) {
    case "close_up":
      return "tight close-up of the focal subject, shallow depth of field, generous negative space";
    case "wide":
      return "wide editorial framing, focal subject in the lower third with caption space above";
    case "overhead":
      return "directly overhead flat-lay composition, evenly lit, focal subject centred";
    case "medium":
    default:
      return "medium shot, focal subject hero-centred at 3/4 view";
  }
}

async function runArtDirectorLegacy(
  input: ArtDirectorInput,
): Promise<VisualConceptBrief> {
  // Gather KB references (visual + brand + product) BEFORE the LLM call so
  // the brief is grounded in reality, not imagination.
  const [visualHits, brandHits, productHits, brandGuidance] = await Promise.all([
    kbSearch({
      query: input.request,
      workspaceId: input.workspaceId,
      collectionKinds: ["visual_reference"],
      campaignId: input.campaignId,
      k: 4,
    }),
    kbSearch({
      query: `brand visual language for ${input.channel ?? "marketing"}`,
      workspaceId: input.workspaceId,
      collectionKinds: ["brand"],
      campaignId: input.campaignId,
      k: 3,
    }),
    kbSearch({
      query: input.request,
      workspaceId: input.workspaceId,
      collectionKinds: ["product"],
      campaignId: input.campaignId,
      k: 3,
    }),
    findBrandGuidance({
      topic: `visual ${input.request}`,
      workspaceId: input.workspaceId,
      limit: 3,
    }),
  ]);

  const referenceUrls = visualHits
    .map((h) => extractImageUrl(h))
    .filter((u): u is string => Boolean(u));

  const userMessage = buildUserMessage({
    request: input.request,
    contentBody: input.contentBody,
    channel: input.channel,
    visualHits,
    brandHits,
    productHits,
    brandGuidance,
    suggestedReferenceUrls: referenceUrls,
  });

  const { text, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(input.model),
    system: ART_DIRECTOR_PROMPT,
    prompt: userMessage,
  });

  await recordLlmUsage({
    agent: "art-director",
    workspaceId: input.workspaceId,
    model: input.model,
    threadRef: input.threadRef ?? undefined,
    jobId: input.jobId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });

  let parsed: z.infer<typeof ConceptSchema>;
  try {
    const jsonText = stripFence(text);
    parsed = ConceptSchema.parse(JSON.parse(jsonText));
  } catch (err) {
    log.warn(
      { err: (err as Error).message, raw: text.slice(0, 400) },
      "art-director output failed to parse; falling back to skeleton",
    );
    parsed = fallbackBrief(input.request);
  }

  // Merge default bans, dedupe.
  const banned = uniq([...DEFAULT_BANNED_AESTHETICS, ...parsed.banned_elements]);

  return {
    concept_summary: parsed.concept_summary,
    composition: parsed.composition,
    focal_point: parsed.focal_point,
    real_subjects: uniq(parsed.real_subjects),
    reference_image_urls: uniq([...parsed.reference_image_urls, ...referenceUrls]),
    style_notes: parsed.style_notes,
    banned_elements: banned,
    motion: parsed.motion,
    slots: parsed.slots,
    references_from_kb: visualHits.map((h) => ({
      documentId: h.documentId,
      title: h.documentTitle,
      similarity: h.similarity,
    })),
  };
}

function buildUserMessage(args: {
  request: string;
  contentBody?: string;
  channel?: string;
  visualHits: KbSearchHit[];
  brandHits: KbSearchHit[];
  productHits: KbSearchHit[];
  brandGuidance: Array<{ source: string; text: string; similarity: number }>;
  suggestedReferenceUrls: string[];
}): string {
  const visualSection = args.visualHits.length
    ? "\n\n# KB Visual References\n" +
      args.visualHits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.documentTitle} (${(h.similarity * 100).toFixed(0)}%)\n${h.body.slice(0, 300)}\nimage_url: ${extractImageUrl(h) ?? "(none)"}`,
        )
        .join("\n\n")
    : "\n\n# KB Visual References\n(none — flag this in concept_summary if a real product reference is essential)";

  const productSection = args.productHits.length
    ? "\n\n# Product facts\n" +
      args.productHits
        .map((h) => `- ${h.documentTitle}: ${h.body.slice(0, 200)}`)
        .join("\n")
    : "";

  const brandSection =
    args.brandHits.length || args.brandGuidance.length
      ? "\n\n# Brand visual guidance\n" +
        [
          ...args.brandHits.map((h) => h.body),
          ...args.brandGuidance.map((g) => g.text),
        ]
          .map((t) => t.slice(0, 200))
          .join("\n\n")
      : "";

  const channelLine = args.channel ? `\nChannel: ${args.channel}` : "";

  return `Design a visual concept for this piece of content.${channelLine}

# Request
${args.request}
${args.contentBody ? `\n# Content body excerpt\n${args.contentBody.slice(0, 1_200)}` : ""}
${visualSection}
${productSection}
${brandSection}

# Suggested reference URLs (carry forward unless they don't fit)
${args.suggestedReferenceUrls.length ? args.suggestedReferenceUrls.join("\n") : "(none)"}

Return JSON matching:
{
  "concept_summary": "...",
  "composition": "...",
  "focal_point": "...",
  "real_subjects": ["..."],
  "reference_image_urls": ["..."],
  "style_notes": "...",
  "banned_elements": ["..."],
  "motion": {
    "opening_state": "the scene at 0–2s, mirroring the still",
    "reveal_beat": "what transforms at 2–6s — the visual idea revealed through motion",
    "settling_state": "the clean hero composition at 6–8s",
    "camera": "one intentional move (e.g. slow push-in, gentle orbit, smooth parallax)"
  },
  "slots": {
    "eyebrow": "short kicker, ≤24 chars (or empty)",
    "headline": "poster-length headline, ≤8 words, reads in 2s",
    "subline": "optional dek that adds context, ≤120 chars (or empty)",
    "cta": "optional CTA, ≤24 chars (or empty)"
  }
}`;
}

function extractImageUrl(hit: KbSearchHit): string | null {
  const meta = hit.documentMetadata as { image_url?: unknown } | undefined;
  if (typeof meta?.image_url === "string" && meta.image_url) return meta.image_url;
  const chunkMeta = hit.metadata as { image_url?: unknown };
  if (typeof chunkMeta?.image_url === "string" && chunkMeta.image_url) {
    return chunkMeta.image_url;
  }
  return null;
}

function stripFence(text: string): string {
  const m = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  return m && m[1] ? m[1] : text.trim();
}

function fallbackBrief(request: string): z.infer<typeof ConceptSchema> {
  return {
    concept_summary: `Visual for: ${request.slice(0, 120)}`,
    composition: "centred hero shot, generous negative space, isometric 3/4 view",
    focal_point: "the specific product feature mentioned in the request",
    real_subjects: [],
    reference_image_urls: [],
    style_notes: "clean editorial, restrained palette, soft cool light",
    banned_elements: [],
    motion: {
      opening_state: "",
      reveal_beat: "",
      settling_state: "",
      camera: "",
    },
    slots: {
      eyebrow: "",
      headline: "",
      subline: "",
      cta: "",
    },
  };
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
