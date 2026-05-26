// OpenAI image generation (gpt-image-1, the model behind ChatGPT image gen).
// Talks to https://api.openai.com/v1/images/generations using OPENAI_API_KEY.
// Returns raw bytes + mime type so the caller can upload directly to Supabase
// Storage without a Replicate-style URL round-trip.

import pino from "pino";
import type { ImageModelInfo } from "@marketing/shared-types";

const log = pino({ name: "openai-image" });
const API_URL = "https://api.openai.com/v1/images/generations";

// gpt-image-1 only accepts these fixed sizes — no arbitrary aspect ratios.
// We round our internal aspect tokens to the closest supported size.
const SIZE_BY_ASPECT: Record<string, string> = {
  square: "1024x1024",
  portrait: "1024x1536",
  tall: "1024x1536",
  landscape: "1536x1024",
  wide: "1536x1024",
};

export type OpenAiImageOpts = {
  prompt: string;
  aspect?: keyof typeof SIZE_BY_ASPECT;
  /** "low" | "medium" | "high" | "auto". Defaults to "high". */
  quality?: "low" | "medium" | "high" | "auto";
};

export type OpenAiImageResult = {
  bytes: Uint8Array;
  mimeType: string;
};

type OpenAiResponse = {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string; type?: string };
};

export async function generateOpenAiImage(
  info: ImageModelInfo,
  opts: OpenAiImageOpts,
): Promise<OpenAiImageResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY must be set to use the OpenAI image provider (gpt-image-1)",
    );
  }

  const aspectKey = opts.aspect ?? "square";
  const size = SIZE_BY_ASPECT[aspectKey] ?? "1024x1024";

  const body = {
    model: info.modelRef,
    prompt: opts.prompt,
    size,
    n: 1,
    quality: opts.quality ?? "medium",
  };

  log.info(
    { model: info.modelRef, size, promptHead: opts.prompt.slice(0, 80) },
    "OpenAI image generate",
  );

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI image API ${res.status}: ${text}`);
  }

  const json = (await res.json()) as OpenAiResponse;

  if (json.error) {
    throw new Error(`OpenAI image error: ${json.error.message ?? json.error.type ?? "unknown"}`);
  }

  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI image response had no b64_json data");
  }

  const bytes = Buffer.from(b64, "base64");
  return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
}
