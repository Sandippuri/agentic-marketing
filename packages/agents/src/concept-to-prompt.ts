/**
 * Convert an Art Director's visual concept brief into a provider-ready
 * image-gen prompt + reference URLs + negative prompt.
 *
 * Pure data transform. No LLM. Used by asset-pipeline workflow once the AD
 * has produced the brief — keeps the prompt-shaping logic in one testable
 * place rather than scattered across asset.ts and asset-variants.ts.
 */
import type { GenerateImageOpts, ImageAspect } from "./image-gen";
import { getPrompt, getRegistryEntry, renderTemplate } from "./prompt-store";
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
  /**
   * Signed URLs for user-uploaded inspiration images. Used as mood/style
   * references — the model should match composition, palette, and lighting
   * but render the brand's actual subject. Placed AFTER brand logos so
   * provider caps drop inspiration before brand. When set, the prompt also
   * appends an explicit "match this style" instruction.
   */
  inspirationReferenceImages?: string[];
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

// Poster discipline — admin-editable via PROMPT_REGISTRY in prompt-store.ts.
// Reads as a checklist, not prose, so it doesn't dilute the logo directive.

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

export async function conceptToVariants(
  brief: VisualConceptBrief,
  opts: ConceptToPromptOpts = {},
): Promise<CandidateVariant[]> {
  const variantCount = opts.variantCount ?? 1;
  const aspect = ASPECT_BY_CHANNEL[opts.channel ?? "linkedin"] ?? "square";
  const negative = buildNegative(brief);

  // Logos first so they survive any provider-side cap. Inspiration next
  // (user explicitly asked for this style). KB visual refs last. Dedupe in
  // case a brand asset has also been indexed as a visual reference.
  const imageInputs = dedupe([
    ...(opts.brandReferenceImages ?? []),
    ...(opts.inspirationReferenceImages ?? []),
    ...brief.reference_image_urls,
  ]).slice(0, MAX_IMAGE_INPUTS);

  // Admin-editable prompts — fetched once per call (5-min cache makes this
  // free at scale). Defaults live in PROMPT_REGISTRY in prompt-store.ts.
  const [posterDiscipline, overlay] = await Promise.all([
    getPrompt(
      "concept_to_prompt.poster_discipline",
      getRegistryEntry("concept_to_prompt.poster_discipline")!.defaultBody,
    ),
    brief.slots.headline
      ? getPrompt(
          "concept_to_prompt.overlay_with_headline",
          getRegistryEntry("concept_to_prompt.overlay_with_headline")!.defaultBody,
        ).then((tpl) =>
          renderTemplate(tpl, { headline: brief.slots.headline }),
        )
      : getPrompt(
          "concept_to_prompt.overlay_no_headline",
          getRegistryEntry("concept_to_prompt.overlay_no_headline")!.defaultBody,
        ),
  ]);

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
  const inspirationHint =
    (opts.inspirationReferenceImages ?? []).length > 0
      ? `Use the user-provided inspiration image as the dominant style reference — match its overall mood, palette, composition, and lighting — but render the brand's actual subject defined above, NOT the subject shown in the inspiration. Do not copy literal elements from the inspiration; borrow its visual language only.`
      : "";
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
      posterDiscipline,
      inspirationHint,
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

// Logo-fidelity guard rails. We DO want the model to render the attached
// brand logo, but we want to suppress "near-miss" model-invented marks:
// fake wordmarks, signage with random text, fabricated badges. Honored by
// SDXL-style providers that support negative prompts; ignored by Nano
// Banana / Flux (their guard is the strict positive-prompt directive).
const ALWAYS_BANNED = [
  "fake brand mark",
  "invented wordmark",
  "made-up logo",
  "misspelled brand name",
  "garbled letterforms",
  "watermark",
];

function buildNegative(brief: VisualConceptBrief): string {
  return [...brief.banned_elements, ...ALWAYS_BANNED].join(", ");
}
