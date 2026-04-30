import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { ASSET_PROMPT } from "@marketing/prompts";
import { loadMemory } from "../memory";
import { generateImage } from "../image-gen";
import { renderTemplate, type TemplateFields } from "../template-render";
import { uploadAsset } from "../asset-uploader";

const log = pino({ name: "asset" });

export type AssetInput = {
  request: string;
  contentId?: string;
  cp: CpClient;
};

export async function runAsset({ request, contentId, cp }: AssetInput): Promise<string> {
  const { text, steps } = await generateText({
    model: anthropic("claude-3-5-sonnet-20241022"),
    system: ASSET_PROMPT,
    prompt: request,
    maxSteps: 10,
    tools: {
      read_visual_memory: tool({
        description: "Read brand visual guidelines from memory/brand/visual.md",
        parameters: z.object({}),
        execute: async () => loadMemory("brand/visual.md"),
      }),

      generate_background: tool({
        description:
          "Generate a background image via Replicate (Stable Diffusion XL). Returns a storagePath after uploading to Supabase.",
        parameters: z.object({
          prompt: z.string().describe("Full Stable Diffusion prompt for the background"),
          negativePrompt: z.string().optional(),
          aspect: z
            .enum(["square", "portrait", "landscape"])
            .optional()
            .describe("square=1024×1024, portrait=1024×1280, landscape=1280×1024"),
        }),
        execute: async ({ prompt, negativePrompt, aspect }) => {
          log.info({ prompt: prompt.slice(0, 80) }, "generate_background called");
          const { url } = await generateImage({ prompt, negativePrompt, aspect });
          // Download and upload to Supabase Storage.
          const storagePath = await uploadAsset(url, `backgrounds/${crypto.randomUUID()}.png`);
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
          const { url, renderId } = await renderTemplate(templateId, mergedFields);
          const storagePath = await uploadAsset(url, `renders/${renderId}.png`);
          log.info({ storagePath, renderId }, "template render uploaded to Supabase");
          return { storagePath, renderId };
        },
      }),

      create_asset: tool({
        description: "Create an asset record in the Control Plane and return the asset ID + signed URL",
        parameters: z.object({
          kind: z.enum(["poster", "hero", "og", "email_header"]),
          storagePath: z.string(),
          templateId: z.string().optional(),
          promptUsed: z.string().optional(),
        }),
        execute: async (input) => {
          log.info({ contentId, kind: input.kind }, "create_asset called");
          const asset = await cp.createAsset({
            contentId,
            kind: input.kind,
            storagePath: input.storagePath,
            templateId: input.templateId,
            promptUsed: input.promptUsed,
          });
          return asset;
        },
      }),
    },
  });

  log.info({ steps: steps.length }, "asset sub-agent finished");
  return text;
}
