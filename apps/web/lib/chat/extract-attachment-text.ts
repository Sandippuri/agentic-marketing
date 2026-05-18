// Extracts plaintext from a chat attachment so we can chunk + embed it into
// the KB. Mirrors brand-extract's pattern (PDF -> native file part to LLM;
// text/* -> UTF-8 decode). Uses Haiku because verbatim extraction does not
// need a frontier model and we want the upload to feel snappy.

import { generateText } from "ai";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import type { LlmModel } from "@marketing/shared-types";

const EXTRACT_MODEL: LlmModel = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT =
  "You are a verbatim text extractor. Output the document's text content as " +
  "clean Markdown. Preserve headings, lists, and paragraph breaks. Do not " +
  "summarise, rewrite, translate, or add commentary. If the document has no " +
  "readable text, return an empty string.";

export type ExtractInput = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  workspaceId: string;
};

/**
 * Returns the extracted markdown body. Throws on unsupported MIME types so
 * callers can surface a clear error to the user.
 */
export async function extractAttachmentText(
  input: ExtractInput,
): Promise<string> {
  if (input.mimeType === "text/markdown" || input.mimeType === "text/plain") {
    return input.buffer.toString("utf8").trim();
  }
  if (input.mimeType !== "application/pdf") {
    throw new Error(`unsupported_mime: ${input.mimeType}`);
  }

  const result = await generateText({
    model: getLanguageModel(EXTRACT_MODEL),
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Extract the full text content of "${input.filename}" as ` +
              `Markdown. Preserve structure; omit page headers/footers and ` +
              `OCR noise.`,
          },
          { type: "file", data: input.buffer, mimeType: "application/pdf" },
        ],
      },
    ],
  });

  await recordLlmUsage({
    agent: "chat-attachment-extract",
    workspaceId: input.workspaceId,
    model: EXTRACT_MODEL,
    usage: result.usage,
    providerMetadata: result.experimental_providerMetadata,
  });

  return result.text.trim();
}
