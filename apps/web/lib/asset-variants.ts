import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { generateImage } from "@marketing/agents/image-gen";
import {
  uploadAsset,
  uploadGeneratedMedia,
} from "@marketing/agents/asset-uploader";
import { buildBrandPromptPrefix } from "@marketing/agents/brand-prompt";
import { renderTemplate } from "@marketing/agents/template-render";
import { getDesignSystem } from "@marketing/agents/design-system-store";
import {
  DEFAULT_IMAGE_MODEL,
  resolveImageModel,
  type AssetKind,
  type ImageModel,
} from "@marketing/shared-types";
import { generateVideoVariant } from "./video-variant";
import { getSignedAssetUrl } from "./supabase/storage";

async function getConfiguredImageModel(): Promise<ImageModel> {
  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "image_model"))
      .limit(1);
    return resolveImageModel(row?.value);
  } catch (err) {
    console.warn(`[asset-variants] failed to read image_model setting; using default`, err);
    return DEFAULT_IMAGE_MODEL;
  }
}

// Visual settings keyed by content_items.type. Mirrors the channel-keyed map
// in single-post.ts; the two are kept in sync because either path can land
// here (Vercel workflow + chat sub-agent submit endpoint).
const VISUALS_BY_TYPE: Record<
  string,
  { kind: AssetKind; aspect: "square" | "portrait" | "landscape" }
> = {
  blog: { kind: "og", aspect: "landscape" },
  linkedin: { kind: "poster", aspect: "square" },
  x_post: { kind: "poster", aspect: "landscape" },
  x_thread: { kind: "poster", aspect: "landscape" },
  email: { kind: "email_header", aspect: "landscape" },
};

// Poster-grade directions. Each variant must read as a polished marketing
// asset, not a stock generic. Concrete composition + lighting + texture, with
// strong negative-space discipline so a title + logo can sit on top without
// fighting the art.
const VARIANT_STYLES = [
  "Editorial photographic poster: hero subject in sharp focus mid-frame, shallow depth of field, atmospheric volumetric light, subtle film grain, premium magazine-cover energy. Composed with clear negative space in the upper third for a headline and lower third for a brand mark. Rich tonality, not flat.",
  "Premium 3D product render: photorealistic CGI of the subject as a tactile object — soft studio lighting, accurate reflections, micro-surface detail, gentle floor shadow. Clean gradient backdrop in brand colors. Hero composition with breathing room above and below. No abstract floating cubes.",
  "Brand-graphic layout: layered editorial composition driven by the brand's design language — vector shapes, typographic scale, and accent strokes derived from the brand mark and palette. Crisp print-magazine craft, depth from overlapping planes and subtle shadows. Reserve clear flat regions for headline and logo placement. NOT flat infographic clip-art.",
];

const MAX_VARIANTS = 3;

/**
 * Template overlay config — when present, posters are rendered in two stages:
 *   1) the image model generates a clean BACKGROUND only (no title, no logo)
 *   2) Bannerbear/Placid composites the real title + real logo on top via
 *      a designed template
 *
 * Layer-name contract (template must expose layers with these names):
 *   - "background"  (image)   — gets the signed URL of the generated bg
 *   - "title"       (text)    — content title
 *   - "logo"        (image)   — signed URL of the brand logo (first variant)
 *
 * Template UID lookup priority:
 *   POSTER_TEMPLATE_ID_<TYPE>  (e.g. POSTER_TEMPLATE_ID_LINKEDIN)
 *   POSTER_TEMPLATE_ID         (generic fallback)
 *
 * If neither a template UID nor a render API key is set, we fall back to
 * single-stage generation (model produces title + logo itself).
 */
function resolvePosterTemplateId(type: string): string | null {
  const perType = process.env[`POSTER_TEMPLATE_ID_${type.toUpperCase()}`];
  if (perType) return perType;
  return process.env.POSTER_TEMPLATE_ID ?? null;
}

function templateRendererAvailable(): boolean {
  return Boolean(
    process.env.BANNERBEAR_API_KEY || process.env.PLACID_API_TOKEN,
  );
}

// Variant priority: most representative first.
const LOGO_PRIORITY = [
  "primary",
  "mark",
  "wordmark",
  "light",
  "dark",
  "monochrome",
] as const;

async function pickPrimaryLogoSignedUrl(
  campaignId: string | null,
): Promise<string | null> {
  try {
    const ds = await getDesignSystem(campaignId);
    const ranked = [...ds.logos]
      .filter((l): l is typeof l & { signedUrl: string } => Boolean(l.signedUrl))
      .sort(
        (a, b) =>
          LOGO_PRIORITY.indexOf(a.variant) - LOGO_PRIORITY.indexOf(b.variant),
      );
    return ranked[0]?.signedUrl ?? null;
  } catch (err) {
    console.warn(
      `[asset-variants] failed to load logo for overlay; continuing without`,
      err,
    );
    return null;
  }
}

// The content sub-agent inserts visual cues like "**[IMAGE 1: a diagram of...]**"
// directly in the body. Pull them out so we can hand them to the image model
// verbatim — those descriptions are richer than anything we'd derive from the
// title alone.
function extractImageMarkers(body: string | null | undefined): string[] {
  if (!body) return [];
  const markers: string[] = [];
  const re = /\[IMAGE(?:\s*\d+)?:\s*([^\]]+)\]/gi;
  for (const match of body.matchAll(re)) {
    const desc = match[1]?.trim();
    if (desc) markers.push(desc);
  }
  return markers;
}

export type GenerateAssetVariantsInput = {
  contentId: string;
  /** Optional override for the subject prompt; defaults to the content title. */
  subject?: string;
  /** Optional override for the content type; defaults to the row in the DB. */
  contentType?: string;
};

/**
 * Generate three image variants for a content item, upload them to Supabase,
 * and insert one `assets` row per successful variant. Best-effort: any
 * Replicate/Supabase failures are logged but never thrown — the caller is
 * usually a fire-and-forget background task.
 *
 * Phase 2.5: when ASSET_PIPELINE=1 (or per-call), routes through the new
 * Art Director → references → judge pipeline that produces specific,
 * on-message imagery instead of generic stock-AI shapes. The legacy path
 * below stays as a fallback while the new pipeline is verified.
 */
export async function generateAssetVariants(
  input: GenerateAssetVariantsInput,
): Promise<{ inserted: number }> {
  if (process.env.ASSET_PIPELINE === "1") {
    return generateViaArtDirectorPipeline(input);
  }
  return generateViaLegacyVariants(input);
}

async function generateViaArtDirectorPipeline(
  input: GenerateAssetVariantsInput,
): Promise<{ inserted: number }> {
  try {
    const { assetPipelineWorkflow } = await import(
      "@/workflows/asset-pipeline"
    );
    const result = await assetPipelineWorkflow({
      contentId: input.contentId,
      request: input.subject,
    });
    return { inserted: result.candidatesGenerated };
  } catch (err) {
    console.warn(
      `[asset-variants] art-director pipeline failed, falling back: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return generateViaLegacyVariants(input);
  }
}

async function generateViaLegacyVariants(
  input: GenerateAssetVariantsInput,
): Promise<{ inserted: number }> {
  const db = getDb();

  // Always re-load the row when we need title or body markers — callers only
  // pass overrides when they have them in hand (e.g. the workflow has the
  // user's request string).
  const [row] = await db
    .select({
      title: schema.contentItems.title,
      type: schema.contentItems.type,
      bodyMd: schema.contentItems.bodyMd,
      campaignId: schema.contentItems.campaignId,
    })
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, input.contentId))
    .limit(1);
  if (!row) {
    console.warn(
      `[asset-variants] content ${input.contentId} not found; skipping`,
    );
    return { inserted: 0 };
  }

  const subject = input.subject ?? row.title;
  const type = input.contentType ?? row.type;
  const markers = extractImageMarkers(row.bodyMd);

  const visuals = VISUALS_BY_TYPE[type];
  if (!visuals) {
    console.warn(
      `[asset-variants] no visual config for type=${type}; skipping`,
    );
    return { inserted: 0 };
  }

  // Prefer the sub-agent's inline [IMAGE N: ...] descriptions — they carry
  // creative direction tied to specific points in the post. Fall back to
  // stylistic variants of the title when no markers are present.
  const subjectClean = (subject ?? "").slice(0, 240);

  // Determine which generation mode is active. Template overlay produces
  // higher-quality posters because real title text and real logo art are
  // composited by a designed template instead of being drawn by the model.
  const templateId = resolvePosterTemplateId(type);
  const useTemplateOverlay = Boolean(templateId) && templateRendererAvailable();

  // When the template will composite the title + logo on top, the model must
  // generate ONLY a clean background — no title text, no fake logo, with
  // negative space reserved for the overlay. When there's no template, the
  // model has to draw the whole poster itself; in that case we still want it
  // to use the *real* logo (attached as visual reference) rather than invent
  // one.
  const buildConstraints = (logoAttached: boolean): string => {
    if (useTemplateOverlay) {
      return "Generate a BACKGROUND ONLY: no headline text, no body text, no logos, no wordmarks, no captions, no watermarks. Reserve calm negative space in the upper third (for a headline) and lower third (for a brand mark) — do NOT fill them with subject. No stock-AI clichés (anonymous floating cubes, generic crypto coins, rainbow gradients on black, wireframe globes).";
    }
    const logoLine = logoAttached
      ? "If a logo is rendered, it MUST match the attached brand reference exactly — do not redraw, restyle, or invent letterforms or marks. Treat it as a placed asset."
      : "Do not invent or hallucinate any brand logos, wordmarks, or proprietary marks.";
    return `${logoLine} No watermarks. No stock-AI clichés (anonymous floating cubes, generic crypto coins, rainbow gradients on black, wireframe globes).`;
  };

  const promptCores: string[] =
    markers.length > 0
      ? markers
          .slice(0, MAX_VARIANTS)
          .map(
            (m) =>
              `${m.slice(0, 280)}. Subject context: ${subjectClean}.`,
          )
      : VARIANT_STYLES.map(
          (style) =>
            `${subjectClean}. Style: ${style}`,
        );

  const model = await getConfiguredImageModel();

  // Inject brand context server-side so workflow-generated variants follow the
  // same palette / banned-looks rules the chat sub-agent's `generate_background`
  // tool already enforces. Without this, the Vercel-workflow path would emit
  // off-brand stock-art posters.
  const { prefix: brandPrefix, referenceImages } = await buildBrandPromptPrefix({
    medium: "image",
    campaignId: row.campaignId,
  });

  // For template overlay we need the brand logo signed URL to feed into the
  // "logo" layer. Pull it from the design system directly; first variant by
  // priority order (primary → mark → wordmark → light → dark → monochrome).
  const overlayLogoUrl = useTemplateOverlay
    ? await pickPrimaryLogoSignedUrl(row.campaignId)
    : null;

  console.log(
    `[asset-variants] generating ${promptCores.length} image(s) for content=${input.contentId} type=${type} source=${markers.length ? "markers" : "title"} model=${model} brandPrefixChars=${brandPrefix.length} logoRefs=${referenceImages.length} templateOverlay=${useTemplateOverlay} templateId=${templateId ?? "none"}`,
  );

  const results = await Promise.allSettled(
    promptCores.map(async (core) => {
      const promptBody = `${core} ${buildConstraints(referenceImages.length > 0)}`;
      const finalPrompt = brandPrefix ? `${brandPrefix}${promptBody}` : promptBody;
      // In overlay mode, don't pass the logo as image input — the model's
      // job is the background only, and a logo reference would tempt it to
      // draw one. In single-stage mode, attach the logo so the model can
      // reproduce it accurately.
      const imageInput =
        !useTemplateOverlay && referenceImages.length > 0
          ? referenceImages
          : undefined;
      const result = await generateImage({
        prompt: finalPrompt,
        aspect: visuals.aspect,
        model,
        imageInput,
      });
      const ext = (result.mimeType.split("/")[1] ?? "png").toLowerCase();
      const bgPath = `variants/${input.contentId}/bg-${crypto.randomUUID()}.${ext}`;
      await uploadGeneratedMedia(result, bgPath);

      if (!useTemplateOverlay) {
        return { storagePath: bgPath, prompt: finalPrompt };
      }

      // Template overlay: composite real title + real logo on top of the bg.
      const bgSignedUrl = await getSignedAssetUrl(bgPath);
      const fields: Record<string, string | { text?: string; image_url?: string }> = {
        background: { image_url: bgSignedUrl },
        title: { text: subjectClean },
      };
      if (overlayLogoUrl) fields.logo = { image_url: overlayLogoUrl };

      const { url: renderedUrl, renderId } = await renderTemplate(
        templateId!,
        fields,
      );
      const finalPath = `variants/${input.contentId}/poster-${renderId}.png`;
      await uploadAsset(renderedUrl, finalPath);
      return { storagePath: finalPath, prompt: finalPrompt };
    }),
  );

  const succeeded = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );

  const failures = results.filter((r) => r.status === "rejected");
  for (const f of failures) {
    console.warn(
      `[asset-variants] variant failed for ${input.contentId}:`,
      (f as PromiseRejectedResult).reason instanceof Error
        ? (f as PromiseRejectedResult).reason.message
        : (f as PromiseRejectedResult).reason,
    );
  }

  if (succeeded.length === 0) return { inserted: 0 };

  await db.insert(schema.assets).values(
    succeeded.map((s) => ({
      contentId: input.contentId,
      kind: visuals.kind,
      storagePath: s.storagePath,
      promptUsed: s.prompt,
      status: "draft" as const,
    })),
  );

  // Fire-and-forget: kick off a promotional video for channels that want one
  // (LinkedIn / X). Veo 3.1 is slow (~30s–2min); we run it after the still
  // images so the approval card always has *something* if video gen times out.
  // Failures are logged inside generateVideoVariant — never re-thrown.
  void generateVideoVariant({
    contentId: input.contentId,
    contentType: type,
    subject: subjectClean,
    firstImageMarker: markers[0] ?? null,
    campaignId: row.campaignId,
  }).catch((err) => {
    console.warn(
      `[asset-variants] video variant failed for ${input.contentId}:`,
      err instanceof Error ? err.message : err,
    );
  });

  return { inserted: succeeded.length };
}
