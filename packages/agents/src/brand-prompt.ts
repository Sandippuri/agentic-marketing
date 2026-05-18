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
import { getPrompt, getRegistryEntry, renderTemplate } from "./prompt-store";
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
  /**
   * Pre-signed partner-brand logos for this campaign. Owned by the caller
   * (asset-pipeline reads them from campaign.visualIdentity.partner_logos
   * and signs each storagePath). Labels are echoed in the prompt so the
   * model knows which mark belongs to which named institution in the copy.
   */
  partnerLogos?: PartnerLogoReference[];
};

export type PartnerLogoReference = {
  url: string;
  label: string;
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
// Duplicate the primary logo this many times in the reference array. Gemini
// (nano-banana family) weights duplicated reference images more heavily —
// repeating the brand logo measurably reduces "model invents a near-miss
// variant" drift. Capped so we don't burn the full MAX_IMAGE_INPUTS=4 budget
// when partner logos or inspiration refs are also in play.
const PRIMARY_LOGO_DUPLICATE_COUNT = 2;

type LogoReference = {
  url: string;
  variant: DesignLogoVariant;
  /** Auto-generated or human-written description; used to verbally anchor the model. */
  notes?: string;
};

function pickLogoReferences(design: DesignSystemDoc): LogoReference[] {
  const ranked = [...design.logos]
    .filter((l): l is typeof l & { signedUrl: string } => Boolean(l.signedUrl))
    .sort((a, b) => LOGO_VARIANT_RANK[a.variant] - LOGO_VARIANT_RANK[b.variant])
    .slice(0, MAX_REFERENCE_LOGOS);
  if (ranked.length === 0) return [];

  // Duplicate the top-ranked entry so it appears multiple times in the
  // attached reference array. The model treats repeats as a fidelity signal.
  const [primary, ...rest] = ranked;
  if (!primary) return [];
  const duplicated: LogoReference[] = [];
  for (let i = 0; i < PRIMARY_LOGO_DUPLICATE_COUNT; i++) {
    duplicated.push({
      url: primary.signedUrl,
      variant: primary.variant,
      notes: primary.notes,
    });
  }
  for (const r of rest) {
    duplicated.push({ url: r.signedUrl, variant: r.variant, notes: r.notes });
  }
  return duplicated;
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
  const brandLogos = opts.medium === "image" && design ? pickLogoReferences(design) : [];
  const partnerLogos = opts.medium === "image" ? opts.partnerLogos ?? [] : [];
  // Brand first (duplicated for fidelity), then partners. concept-to-prompt
  // caps at MAX_IMAGE_INPUTS=4 and weights earlier entries higher on Gemini.
  const referenceImages = [
    ...brandLogos.map((l) => l.url),
    ...partnerLogos.map((p) => p.url),
  ];

  // === TOP-OF-PROMPT LOGO DIRECTIVE ========================================
  // Promoted above design system / visual direction because logo fidelity is
  // the single most common failure mode. Wording is admin-editable — see
  // PROMPT_REGISTRY in prompt-store.ts for the source of truth.
  const logoDirectives: string[] = [];
  if (brandLogos.length > 0) {
    const descs = brandLogos
      .filter((l) => l.notes && l.notes.trim())
      .map((l) => l.notes!.trim())
      .filter((v, i, a) => a.indexOf(v) === i);
    const tpl = await getPrompt(
      "brand_prompt.logo_directive",
      getRegistryEntry("brand_prompt.logo_directive")!.defaultBody,
    );
    logoDirectives.push(
      renderTemplate(tpl, {
        brandLogoCount: brandLogos.length,
        descriptionSuffix:
          descs.length > 0 ? `\nDescription: ${descs.join(" | ")}` : "",
      }),
    );
  }
  if (partnerLogos.length > 0) {
    const tpl = await getPrompt(
      "brand_prompt.partner_logo_directive",
      getRegistryEntry("brand_prompt.partner_logo_directive")!.defaultBody,
    );
    logoDirectives.push(
      renderTemplate(tpl, {
        partnerLogoCount: partnerLogos.length,
        labels: partnerLogos.map((p) => `"${p.label}"`).join(", "),
      }),
    );
  }
  if (opts.medium === "image") {
    logoDirectives.push(
      await getPrompt(
        "brand_prompt.no_fabrication_rule",
        getRegistryEntry("brand_prompt.no_fabrication_rule")!.defaultBody,
      ),
    );
  }
  if (logoDirectives.length > 0) {
    sections.push(logoDirectives.join("\n\n"));
  }
  // === /TOP-OF-PROMPT LOGO DIRECTIVE =======================================

  if (design) {
    const formatted = formatDesignSystemForPrompt(design).trim();
    if (formatted && !formatted.startsWith("(design system not yet")) {
      sections.push(`BRAND DESIGN SYSTEM (use these EXACTLY — copy hex codes verbatim):\n${formatted}`);
    }
  }

  if (visual?.body.trim()) {
    sections.push(`BRAND VISUAL DIRECTION:\n${visual.body.trim()}`);
  }

  if (sections.length === 0) return { prefix: "", referenceImages };

  const framing =
    opts.medium === "video"
      ? await getPrompt(
          "brand_prompt.framing_video",
          getRegistryEntry("brand_prompt.framing_video")!.defaultBody,
        )
      : await getPrompt(
          "brand_prompt.framing_image",
          getRegistryEntry("brand_prompt.framing_image")!.defaultBody,
        );

  return {
    prefix: `${framing}\n\n${sections.join("\n\n")}\n\n--- USER PROMPT ---\n`,
    referenceImages,
  };
}
