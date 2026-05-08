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
  /** Channel — drives aspect ratio. */
  channel?: string;
  /** Number of candidates to generate. Default 3. */
  variantCount?: number;
};

const VARIANT_PERSPECTIVES = [
  "isometric 3/4 view, hero composition with the focal point centred",
  "tight macro shot of the focal subject with the rest blurred away",
  "wide editorial framing, focal subject offset to the right with caption space",
];

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
  const variantCount = opts.variantCount ?? 3;
  const aspect = ASPECT_BY_CHANNEL[opts.channel ?? "linkedin"] ?? "square";
  const negative = buildNegative(brief);

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
  const noNoise = `No text, no logos, no watermarks. No anonymous abstract shapes.`;

  return Array.from({ length: variantCount }).map((_, i) => {
    const perspective = VARIANT_PERSPECTIVES[i % VARIANT_PERSPECTIVES.length]!;
    const promptCore = [
      brief.concept_summary,
      `${perspective}.`,
      focal,
      subjects,
      style,
      refsHint,
      noNoise,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      index: i,
      prompt: opts.brandPrefix ? `${opts.brandPrefix}${promptCore}` : promptCore,
      negativePrompt: negative,
      imageInput: brief.reference_image_urls,
      aspect,
    };
  });
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
