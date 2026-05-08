// Native Google Gemini image generation (Nano Banana / Nano Banana 2).
// Talks to https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// using GEMINI_API_KEY. Returns raw bytes + mime type so the caller can upload
// directly to Supabase Storage without a Replicate-style URL round-trip.

import pino from "pino";
import type { ImageModelInfo } from "@marketing/shared-types";

const log = pino({ name: "google-image" });
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Aspect strings recognized by the Gemini image API (image_config.aspect_ratio).
// Mapped from our internal ImageAspect union by the dispatcher.
const ASPECT_RATIO: Record<string, string> = {
  square: "1:1",
  portrait: "3:4",
  landscape: "4:3",
  wide: "16:9",
  tall: "9:16",
};

export type GoogleImageOpts = {
  prompt: string;
  aspect?: keyof typeof ASPECT_RATIO;
  /** Public URLs for reference / edit images. Each is fetched and inlined as base64. */
  imageInput?: string[];
};

export type GoogleImageResult = {
  bytes: Uint8Array;
  mimeType: string;
};

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

async function fetchAsInlineData(
  url: string,
): Promise<{ mimeType: string; data: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch reference image ${url}: ${res.status}`);
  }
  const mimeType = res.headers.get("content-type") ?? "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, data: buf.toString("base64") };
}

export async function generateGoogleImage(
  info: ImageModelInfo,
  opts: GoogleImageOpts,
): Promise<GoogleImageResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY must be set to use the native Google image provider",
    );
  }

  const aspectKey = opts.aspect ?? "square";
  const aspectRatio = ASPECT_RATIO[aspectKey] ?? "1:1";

  const parts: GeminiPart[] = [{ text: opts.prompt }];
  if (opts.imageInput?.length) {
    for (const url of opts.imageInput) {
      const inline = await fetchAsInlineData(url);
      parts.push({ inlineData: inline });
    }
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      // Tell the model to emit an image. Required for image-output models.
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio },
    },
  };

  const url = `${API_BASE}/models/${info.modelRef}:generateContent?key=${encodeURIComponent(apiKey)}`;

  log.info(
    { model: info.modelRef, aspectRatio, promptHead: opts.prompt.slice(0, 80) },
    "Gemini image generate",
  );

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini image API ${res.status}: ${text}`);
  }

  const json = (await res.json()) as GeminiResponse;

  if (json.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini image blocked: ${json.promptFeedback.blockReason}`,
    );
  }

  const inline = json.candidates
    ?.flatMap((c) => c.content?.parts ?? [])
    .find((p): p is Extract<GeminiPart, { inlineData: unknown }> =>
      "inlineData" in p,
    );

  if (!inline) {
    throw new Error(
      `Gemini image response had no inlineData (finish=${json.candidates?.[0]?.finishReason ?? "?"})`,
    );
  }

  const bytes = Buffer.from(inline.inlineData.data, "base64");
  return {
    bytes: new Uint8Array(bytes),
    mimeType: inline.inlineData.mimeType || "image/png",
  };
}
