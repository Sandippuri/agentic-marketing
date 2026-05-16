/**
 * brand-prompt — build a brand-context prefix that is *always* prepended to
 * image/video generation prompts. Server-side injection (rather than relying
 * on the LLM to call read_visual_memory / read_design_system) means brand
 * adherence is non-skippable.
 *
 * Both stores have a 5-minute in-process TTL, so calling this on every
 * generation is cheap.
 */

import pino from "pino";
import { getBrandMemoryDoc } from "./brand-store";
import {
  getDesignSystem,
  formatDesignSystemForPrompt,
  type DesignSystemDoc,
} from "./design-system-store";
import type { DesignLogoVariant } from "@marketing/shared-types";

const log = pino({ name: "brand-prompt" });

export type BrandPromptOptions = {
  /**
   * Workspace scope — REQUIRED for multi-tenant correctness. Without it the
   * CP endpoints fall back to LEGACY_WORKSPACE_ID and every workspace gets
   * user1's brand. Threaded by every caller from the active job/run.
   */
  workspaceId?: string | null;
  campaignId?: string | null;
  /** "image" | "video" — tweaks the framing line. */
  medium: "image" | "video";
};

export type BrandPromptPrefix = {
  /** Text to prepend to the user prompt. Empty string if no brand context. */
  prefix: string;
  /** Signed logo URLs to pass as visual reference inputs to the image model. */
  referenceImages: string[];
};

// Variant priority — most representative first. We attach the top-ranked
// signed URLs so the model can reproduce the actual mark instead of
// hallucinating one from a text URL.
const LOGO_VARIANT_RANK: Record<DesignLogoVariant, number> = {
  primary: 0,
  mark: 1,
  wordmark: 2,
  light: 3,
  dark: 4,
  monochrome: 5,
};

const MAX_REFERENCE_LOGOS = 2;

function pickLogoReferenceUrls(design: DesignSystemDoc): string[] {
  const ranked = [...design.logos]
    .filter((l): l is typeof l & { signedUrl: string } => Boolean(l.signedUrl))
    .sort((a, b) => LOGO_VARIANT_RANK[a.variant] - LOGO_VARIANT_RANK[b.variant]);
  return ranked.slice(0, MAX_REFERENCE_LOGOS).map((l) => l.signedUrl);
}

export async function buildBrandPromptPrefix(
  opts: BrandPromptOptions,
): Promise<BrandPromptPrefix> {
  const scope = { workspaceId: opts.workspaceId, campaignId: opts.campaignId };
  if (!opts.workspaceId) {
    log.warn(
      { campaignId: opts.campaignId, medium: opts.medium },
      "buildBrandPromptPrefix called without workspaceId — CP will fall back to LEGACY_WORKSPACE_ID. Fix the caller.",
    );
  }
  const [design, visual] = await Promise.all([
    getDesignSystem(scope).catch((err) => {
      log.warn({ err: (err as Error).message }, "design system fetch failed");
      return null;
    }),
    getBrandMemoryDoc("brand.visual", scope).catch((err) => {
      log.warn({ err: (err as Error).message }, "visual memory fetch failed");
      return null;
    }),
  ]);

  const sections: string[] = [];
  const referenceImages =
    opts.medium === "image" && design ? pickLogoReferenceUrls(design) : [];

  if (design) {
    const formatted = formatDesignSystemForPrompt(design).trim();
    if (formatted && !formatted.startsWith("(design system not yet")) {
      sections.push(`BRAND DESIGN SYSTEM (use these EXACTLY — copy hex codes verbatim):\n${formatted}`);
    }
  }

  if (visual?.body.trim()) {
    sections.push(`BRAND VISUAL DIRECTION:\n${visual.body.trim()}`);
  }

  if (referenceImages.length > 0) {
    sections.push(
      `BRAND LOGO REFERENCE: ${referenceImages.length} image(s) attached alongside this prompt show the official brand logo. If a logo appears in the output, reproduce it exactly as attached — do NOT redraw, restyle, or invent letterforms, glyphs, or marks. Preserve proportions, colors, and shape. Treat it as a placed asset, not a subject to reinterpret.`,
    );
  }

  if (sections.length === 0) return { prefix: "", referenceImages };

  const framing =
    opts.medium === "video"
      ? "The clip MUST follow the brand below — palette, mood, banned looks all apply to motion. Avoid on-screen text."
      : "The image MUST follow the brand below. Hex codes are authoritative; do not invent colors.";

  return {
    prefix: `${framing}\n\n${sections.join("\n\n")}\n\n--- USER PROMPT ---\n`,
    referenceImages,
  };
}
