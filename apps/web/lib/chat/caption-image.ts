// Vision pass that turns an uploaded image into the KB shape expected by
// the Art Director (packages/agents/src/sub-agents/art-director.ts). The
// caption + tags become the doc's body_md / metadata so kb_search can
// surface it when the user later asks for "a similar image".
//
// We use Haiku here because describing one image accurately is well within
// its capability and the upload should feel snappy. The schema is
// permissive — empty arrays are valid because some references have no
// obvious "use for" cues.

import { generateObject } from "ai";
import { z } from "zod";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import type { LlmModel } from "@marketing/shared-types";

const CAPTION_MODEL: LlmModel = "claude-haiku-4-5-20251001";

const CaptionSchema = z.object({
  description: z
    .string()
    .min(40)
    .describe(
      "Markdown paragraph (~80–200 words) describing what's in the image: subject, composition, lighting, palette, mood, style. Concrete and useful as a style anchor.",
    ),
  tags: z
    .array(z.string().min(1).max(40))
    .max(12)
    .describe(
      "5–10 short tags. Mix subject, style, palette, era, mood. e.g. 'isometric', 'pastel palette', 'product hero', 'low contrast'.",
    ),
  useFor: z
    .array(z.string().min(1).max(60))
    .max(8)
    .describe(
      "Concrete use cases the Art Director should reach for this when. e.g. 'product hero shots', 'editorial wide framings', 'soft pastel palettes'.",
    ),
});

export type ImageCaption = z.infer<typeof CaptionSchema>;

const SYSTEM_PROMPT =
  "You are a brand-side art director cataloguing a reference image for " +
  "later reuse. Describe what is actually visible and how it feels visually. " +
  "Be concrete: subjects, composition, lighting, palette, era, mood. Avoid " +
  "speculation about who made it or why. Output JSON matching the schema.";

export type CaptionInput = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  workspaceId: string;
};

export async function captionImage(input: CaptionInput): Promise<ImageCaption> {
  const result = await generateObject({
    model: getLanguageModel(CAPTION_MODEL),
    schema: CaptionSchema,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Catalogue this reference image (filename: "${input.filename}"). ` +
              `Return description, tags, and useFor hints.`,
          },
          { type: "file", data: input.buffer, mimeType: input.mimeType },
        ],
      },
    ],
  });

  await recordLlmUsage({
    agent: "chat-attachment-caption",
    workspaceId: input.workspaceId,
    model: CAPTION_MODEL,
    usage: result.usage,
    providerMetadata: result.experimental_providerMetadata,
  });

  return result.object;
}
