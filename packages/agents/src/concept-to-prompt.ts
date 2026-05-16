/**
 * Convert an Art Director's visual concept brief into a provider-ready
 * image-gen prompt + reference URLs + negative prompt.
 *
 * Pure data transform. No LLM. Used by asset-pipeline workflow once the AD
 * has produced the brief — keeps the prompt-shaping logic in one testable
 * place rather than scattered across asset.ts and asset-variants.ts.
 */
import type { GenerateImageOpts, ImageAspect } from "./image-gen";
import type { VisualConceptBrief } from "./sub-agents/art-director";

export type CandidateVariant = {
  /** Stable id within the run (variant_index). */
  index: number;
  /** Provider-specific prompt. */
  prompt: string;
  /** Negative-prompt seeds (banned aesthetics + element). */
  negativePrompt: string;
  /** Image references — passed as imageInput to models with supportsImageInput. */
  imageInput: string[];
  /** Aspect ratio derived from the channel. */
  aspect: ImageAspect;
};

export type ConceptToPromptOpts = {
  /** Brand colour palette + tokens already formatted into a prompt-friendly prefix. */
  brandPrefix?: string;
  /**
   * Signed URLs for the brand's official logos. Passed FIRST in `imageInput`
   * so providers that cap reference images (or weight earlier inputs more
   * heavily, like Gemini) treat the logo as the priority reference. Without
   * these, the model has only a text instruction telling it a logo is
   * attached — and hallucinates a near-miss mark from the brand name.
   */
  brandReferenceImages?: string[];
  /** Channel — drives aspect ratio. */
  channel?: string;
  /**
   * Number of candidates to generate. Default 1 (post-0029 — see asset-pipeline
   * docstring). Pass >1 only when the caller actually wants a fanout (legacy
   * paths or experiments).
   */
  variantCount?: number;
  /**
   * Optional rejection reason from the judge. When set, the prompt prepends
   * a "fix the following" instruction so the retry generates against the
   * specific failure mode rather than a fresh roll of the dice.
   */
  retryReason?: string;
};

// Cap the number of references we hand to the image model. Brand logos take
// precedence (placed first); KB visual refs fill remaining slots. Most
// providers degrade past 4 inputs.
const MAX_IMAGE_INPUTS = 4;

// Production runs use variantCount=1, so index 0 is the only perspective the
// model ever sees. The previous default ("isometric 3/4 view") is what kept
// producing crypto-cube-on-spokes layouts — replaced with editorial poster
// framing. Isometric is still available at index 2 as an opt-in for fanouts.
const VARIANT_PERSPECTIVES = [
  "editorial poster composition, single hero subject occupying the lower two-thirds, generous negative space above for the headline, asymmetric balance — not symmetric, not radial",
  "tight macro shot of the focal subject with the rest softly out of focus, magazine-cover framing",
  "isometric 3/4 view, hero composition with the focal point centred",
];

// Marketing-grade poster discipline. Injected into every prompt regardless of
// perspective so the model treats the canvas as a poster (clear hierarchy,
// breathable type, one idea) instead of a diagram (cubes, arrows, fake labels).
const POSTER_DISCIPLINE =
  "Treat this as a marketing POSTER, not a technical diagram. One clear focal subject. Strong typographic hierarchy with the headline as the dominant element. Generous negative space — let the composition breathe. Single light source, deliberate shadows. Photographic or rendered-product realism preferred over flat illustration. Do NOT invent on-canvas labels, fake percentages, fee tags, route arrows, or technical annotations the brief did not ask for.";

const ASPECT_BY_CHANNEL: Record<string, ImageAspect> = {
  internal_blog: "landscape",
  blog: "landscape",
  linkedin: "square",
  x: "landscape",
  x_post: "landscape",
  x_thread: "landscape",
  email: "landscape",
  email_hubspot: "landscape",
  email_mailchimp: "landscape",
};

export function conceptToVariants(
  brief: VisualConceptBrief,
  opts: ConceptToPromptOpts = {},
): CandidateVariant[] {
  const variantCount = opts.variantCount ?? 1;
  const aspect = ASPECT_BY_CHANNEL[opts.channel ?? "linkedin"] ?? "square";
  const negative = buildNegative(brief);

  // Logos first so they survive any provider-side cap; dedupe against KB refs
  // in case a brand asset has also been indexed as a visual reference.
  const imageInputs = dedupe([
    ...(opts.brandReferenceImages ?? []),
    ...brief.reference_image_urls,
  ]).slice(0, MAX_IMAGE_INPUTS);

  const subjects =
    brief.real_subjects.length > 0
      ? `Subjects (must appear): ${brief.real_subjects.join("; ")}.`
      : "";
  const focal = `Focal point: ${brief.focal_point}.`;
  const style = brief.style_notes ? `Style: ${brief.style_notes}.` : "";
  const refsHint =
    brief.reference_image_urls.length > 0
      ? `Match the visual language of the reference images provided (composition, lighting, real product geometry).`
      : "";
  // Post-0029 the model renders overlay text natively (no template chrome
  // step). Only suppress text when there's no headline to render.
  const overlay = brief.slots.headline
    ? `Render the headline text "${brief.slots.headline}" cleanly into the image with brand-appropriate typography. No other text, no logos, no watermarks.`
    : `No text, no logos, no watermarks. No anonymous abstract shapes.`;
  const retryFix = opts.retryReason
    ? `Previous attempt was rejected for: ${opts.retryReason}. Fix this specifically.`
    : "";

  return Array.from({ length: variantCount }).map((_, i) => {
    const perspective = VARIANT_PERSPECTIVES[i % VARIANT_PERSPECTIVES.length]!;
    const promptCore = [
      retryFix,
      brief.concept_summary,
      `${perspective}.`,
      focal,
      subjects,
      style,
      POSTER_DISCIPLINE,
      refsHint,
      overlay,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      index: i,
      prompt: opts.brandPrefix ? `${opts.brandPrefix}${promptCore}` : promptCore,
      negativePrompt: negative,
      imageInput: imageInputs,
      aspect,
    };
  });
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

export function variantToImageOpts(
  variant: CandidateVariant,
): GenerateImageOpts {
  return {
    prompt: variant.prompt,
    negativePrompt: variant.negativePrompt,
    aspect: variant.aspect,
    imageInput: variant.imageInput.length > 0 ? variant.imageInput : undefined,
  };
}

function buildNegative(brief: VisualConceptBrief): string {
  return brief.banned_elements.join(", ");
}
