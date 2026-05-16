import { generateText, tool } from "ai";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { ASSET_PROMPT } from "@marketing/prompts";
import { getBrandMemoryDoc } from "../brand-store";
import {
  getDesignSystem,
  formatDesignSystemForPrompt,
} from "../design-system-store";
import { generateImage } from "../image-gen";
import { generateVideo } from "../video-gen";
import { buildBrandPromptPrefix } from "../brand-prompt";
import { renderTemplate, type TemplateFields } from "../template-render";
import {
  uploadAsset,
  uploadAssetBytes,
  uploadGeneratedMedia,
} from "../asset-uploader";
import {
  resolveImageModel,
  resolveVideoModel,
  type ImageModel,
  type LlmModel,
  type VideoModel,
} from "@marketing/shared-types";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";

const log = pino({ name: "asset" });

export type AssetInput = {
  request: string;
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  contentId?: string;
  cp: CpClient;
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

async function loadConfiguredImageModel(cp: CpClient): Promise<ImageModel> {
  try {
    const settings = await cp.getSettings();
    return resolveImageModel(settings.image_model);
  } catch (err) {
    log.warn({ err }, "failed to load image_model from settings; using default");
    return resolveImageModel(undefined);
  }
}

async function loadConfiguredVideoModel(cp: CpClient): Promise<VideoModel> {
  try {
    const settings = await cp.getSettings();
    return resolveVideoModel(settings.video_model);
  } catch (err) {
    log.warn({ err }, "failed to load video_model from settings; using default");
    return resolveVideoModel(undefined);
  }
}

export async function runAsset({ request, workspaceId, contentId, cp, model, threadRef, jobId, workflowRunId }: AssetInput): Promise<string> {
  const imageModel = await loadConfiguredImageModel(cp);
  const videoModel = await loadConfiguredVideoModel(cp);
  log.info({ imageModel, videoModel }, "asset sub-agent using configured models");
  log.info(
    { workspaceId, contentId, jobId, workflowRunId, request },
    "asset sub-agent received request",
  );

  const { text, steps, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    system: ASSET_PROMPT,
    prompt: request,
    maxSteps: 10,
    tools: {
      read_visual_memory: tool({
        description:
          "Read brand visual guidelines (palette, typography, banned looks, aspect ratios). Editable in the admin UI at /admin/brand under 'Visual guidelines'.",
        parameters: z.object({}),
        execute: async () => {
          const doc = await getBrandMemoryDoc("brand.visual", { workspaceId });
          return doc.body;
        },
      }),

      read_design_system: tool({
        description:
          "Read the structured brand design system: exact hex color values (with roles), typography families/weights, signed logo URLs (expire in ~1 hour), and spacing/radii/shadow tokens. Use these AS-IS — copy hex codes verbatim into image-gen prompts; pass logo URLs into render_template's image fields. Editable in the admin UI at /admin/design-system.",
        parameters: z.object({}),
        execute: async () => {
          const doc = await getDesignSystem({ workspaceId });
          return {
            formatted: formatDesignSystemForPrompt(doc),
            colors: doc.colors,
            logos: doc.logos,
          };
        },
      }),

      generate_background: tool({
        description:
          "Generate a background image via the configured image model (see Settings → Image generation model). Returns a storagePath after uploading to Supabase.",
        parameters: z.object({
          prompt: z.string().describe("Full image-generation prompt for the background"),
          negativePrompt: z
            .string()
            .optional()
            .describe("Only honored by SDXL; ignored by Nano Banana / Flux."),
          aspect: z
            .enum(["square", "portrait", "landscape"])
            .optional()
            .describe("square=1:1, portrait=3:4, landscape=4:3"),
        }),
        execute: async ({ prompt, negativePrompt, aspect }) => {
          log.info({ prompt: prompt.slice(0, 80), imageModel }, "generate_background called");
          const { prefix, referenceImages } = await buildBrandPromptPrefix({
            workspaceId,
            medium: "image",
          });
          const finalPrompt = prefix ? `${prefix}${prompt}` : prompt;
          log.info(
            {
              workspaceId,
              contentId,
              imageModel,
              aspect,
              negativePrompt,
              brandPrefixChars: prefix.length,
              logoReferenceCount: referenceImages.length,
              rawPrompt: prompt,
              brandPrefix: prefix,
              finalPrompt,
            },
            "IMAGE PROMPT (full) — about to call generateImage",
          );
          const result = await generateImage({
            prompt: finalPrompt,
            negativePrompt,
            aspect,
            model: imageModel,
            imageInput: referenceImages.length > 0 ? referenceImages : undefined,
          });
          const ext = (result.mimeType.split("/")[1] ?? "png").toLowerCase();
          const { storagePath } = await uploadGeneratedMedia(
            result,
            `backgrounds/${crypto.randomUUID()}.${ext}`,
          );
          log.info({ storagePath }, "background uploaded to Supabase");
          return { storagePath };
        },
      }),

      render_template: tool({
        description:
          "Render a Bannerbear or Placid template with text/image fields. Returns storagePath after uploading to Supabase.",
        parameters: z.object({
          templateId: z.string().describe("Bannerbear template UID or Placid template UUID"),
          fields: z
            .record(z.union([z.string(), z.object({ text: z.string().optional(), image_url: z.string().optional() })]))
            .describe("Layer name → value mapping"),
          backgroundUrl: z.string().optional().describe("Supabase signed URL or public URL to use as background layer"),
        }),
        execute: async ({ templateId, fields, backgroundUrl }) => {
          log.info({ templateId }, "render_template called");
          const mergedFields: TemplateFields = { ...fields };
          if (backgroundUrl) mergedFields["background"] = { image_url: backgroundUrl };
          log.info(
            {
              workspaceId,
              contentId,
              templateId,
              backgroundUrl,
              fields: mergedFields,
            },
            "TEMPLATE RENDER (full) — about to call renderTemplate",
          );
          const { url, renderId } = await renderTemplate(templateId, mergedFields);
          const storagePath = await uploadAsset(url, `renders/${renderId}.png`);
          log.info({ storagePath, renderId }, "template render uploaded to Supabase");
          return { storagePath, renderId };
        },
      }),

      generate_video: tool({
        description:
          "Generate a short promotional video clip (~8s) via the configured video model (see Settings → Video generation model). Returns a storagePath, mimeType and durationSec. Use 16:9 for X / landscape feed contexts and 9:16 for vertical LinkedIn / mobile placements. Optionally pass `firstFrameUrl` (a signed Supabase URL) to drive image-to-video — produces clips far more on-brand than text-only prompts.",
        parameters: z.object({
          prompt: z
            .string()
            .describe(
              "Motion-aware prompt. Be concrete about what moves and how (camera, subject). Avoid on-screen text — the still image has that.",
            ),
          aspect: z
            .enum(["16:9", "9:16"])
            .optional()
            .describe("16:9 for X feed; 9:16 for vertical LinkedIn / Reels."),
          durationSec: z
            .number()
            .int()
            .min(4)
            .max(8)
            .optional()
            .describe("Clip length in seconds. Veo 3.1 supports 4–8s. Defaults to 8."),
          firstFrameUrl: z
            .string()
            .url()
            .optional()
            .describe(
              "Signed URL of an existing still image to use as the first frame. Triggers image-to-video.",
            ),
          withAudio: z
            .boolean()
            .optional()
            .describe("Generate native audio. Defaults to true."),
        }),
        execute: async ({ prompt, aspect, durationSec, firstFrameUrl, withAudio }) => {
          log.info(
            {
              videoModel,
              aspect,
              durationSec,
              i2v: Boolean(firstFrameUrl),
              promptHead: prompt.slice(0, 80),
            },
            "generate_video called",
          );
          const { prefix } = await buildBrandPromptPrefix({
            workspaceId,
            medium: "video",
          });
          const finalPrompt = prefix ? `${prefix}${prompt}` : prompt;
          log.info(
            {
              workspaceId,
              contentId,
              videoModel,
              aspect,
              durationSec,
              i2v: Boolean(firstFrameUrl),
              firstFrameUrl,
              withAudio,
              brandPrefixChars: prefix.length,
              rawPrompt: prompt,
              brandPrefix: prefix,
              finalPrompt,
            },
            "VIDEO PROMPT (full) — about to call generateVideo",
          );
          const result = await generateVideo({
            prompt: finalPrompt,
            aspect,
            durationSec,
            imageUrl: firstFrameUrl,
            withAudio,
            model: videoModel,
          });
          const ext = (result.mimeType.split("/")[1] ?? "mp4").toLowerCase();
          const storagePath = `videos/${crypto.randomUUID()}.${ext}`;
          await uploadAssetBytes(result.bytes, result.mimeType, storagePath);
          log.info({ storagePath, durationSec: result.durationSec }, "video uploaded to Supabase");
          return {
            storagePath,
            mimeType: result.mimeType,
            durationSec: result.durationSec,
          };
        },
      }),

      create_asset: tool({
        description:
          "Create an asset record in the Control Plane and return the asset ID + signed URL. Use kind='video_post' (with mimeType + durationSec) for Veo clips; image kinds otherwise.",
        parameters: z.object({
          kind: z.enum(["poster", "hero", "og", "email_header", "video_post"]),
          storagePath: z.string(),
          templateId: z.string().optional(),
          promptUsed: z.string().optional(),
          mimeType: z
            .string()
            .optional()
            .describe("Required for kind='video_post' (e.g. 'video/mp4')."),
          durationSec: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Required for kind='video_post'."),
        }),
        execute: async (input) => {
          log.info({ contentId, kind: input.kind }, "create_asset called");
          const asset = await cp.createAsset({
            contentId,
            kind: input.kind,
            storagePath: input.storagePath,
            templateId: input.templateId,
            promptUsed: input.promptUsed,
            mimeType: input.mimeType,
            durationSec: input.durationSec,
          });
          return asset;
        },
      }),
    },
  });

  log.info({ steps: steps.length }, "asset sub-agent finished");
  await recordLlmUsage({
    agent: "asset",
    workspaceId,
    model,
    threadRef,
    jobId,
    workflowRunId,
    usage,
    providerMetadata: experimental_providerMetadata,
  });
  return text;
}
