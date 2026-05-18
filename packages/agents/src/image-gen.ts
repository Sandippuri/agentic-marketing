// Image generation dispatcher. Routes by `provider` on the model registry.
//
// - provider="google"     → native Gemini API (Nano Banana / Nano Banana 2),
//                           uses GEMINI_API_KEY. Returns bytes inline.
// - provider="replicate"  → Replicate predictions endpoint, returns a URL.
//
// Callers get a uniform { bytes?, url?, mimeType } shape so upload helpers
// can pick the right path.

import pino from "pino";
import {
  DEFAULT_IMAGE_MODEL,
  getImageModelInfo,
  type ImageModel,
  type ImageModelInfo,
} from "@marketing/shared-types";
import { generateGoogleImage } from "./providers/google-image";
import { generateOpenAiImage } from "./providers/openai-image";

const log = pino({ name: "image-gen" });

const REPLICATE_API = "https://api.replicate.com/v1";

// Internal aspect tokens. Mapped to provider-specific strings inside each branch.
// `wide`/`tall` are LinkedIn/X-friendly and were added when video came online,
// but image providers also accept them. Note: gpt-image-1 only supports
// 1:1 / 2:3 / 3:2, so wide/tall are rounded to portrait/landscape there.
export type ImageAspect =
  | "square"
  | "portrait"
  | "landscape"
  | "wide"
  | "tall";

export type GenerateImageOpts = {
  prompt: string;
  /** Ignored for models that don't support negative prompts. */
  negativePrompt?: string;
  aspect?: ImageAspect;
  /** Edit/style transfer reference URLs. Honored only by models with `supportsImageInput`. */
  imageInput?: string[];
  /** Override the configured/default model for this call. */
  model?: ImageModel;
};

/**
 * Result is one of:
 *   - `{ url, mimeType }`     — Replicate-style remote URL (caller must download).
 *   - `{ bytes, mimeType }`   — Inline raw bytes (Google native API).
 * `mimeType` is always set so the uploader can preserve the right Content-Type.
 */
export type GenerateImageResult = {
  url?: string;
  bytes?: Uint8Array;
  mimeType: string;
};

const ASPECT_RATIO_STRING: Record<ImageAspect, string> = {
  square:    "1:1",
  portrait:  "3:4",
  landscape: "4:3",
  wide:      "16:9",
  tall:      "9:16",
};

async function pollReplicate(
  predictionId: string,
  token: string,
): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${REPLICATE_API}/predictions/${predictionId}`, {
      headers: { Authorization: `Token ${token}` },
    });
    const data = (await res.json()) as {
      status: string;
      output?: string | string[];
      error?: string;
    };
    if (data.status === "succeeded" && data.output) {
      const url = Array.isArray(data.output) ? data.output[0] : data.output;
      if (url) return url;
    }
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(
        `Replicate prediction ${data.status}: ${data.error ?? "unknown"}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Replicate prediction timed out after 2 minutes");
}

function buildReplicateInput(
  info: ImageModelInfo,
  opts: GenerateImageOpts,
): Record<string, unknown> {
  const aspect: ImageAspect = opts.aspect ?? "square";

  switch (info.inputShape) {
    case "ideogram": {
      const input: Record<string, unknown> = {
        prompt: opts.prompt,
        aspect_ratio: ASPECT_RATIO_STRING[aspect],
        magic_prompt_option: "Auto",
      };
      if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt;
      return input;
    }
    case "google-image": {
      throw new Error(
        "google-image inputShape must not be routed through Replicate",
      );
    }
    case "openai-image": {
      throw new Error(
        "openai-image inputShape must not be routed through Replicate",
      );
    }
  }
}

async function callReplicate(
  info: ImageModelInfo,
  opts: GenerateImageOpts,
): Promise<GenerateImageResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN must be set");

  const input = buildReplicateInput(info, opts);

  // `owner/name:version` → /v1/predictions with `version`.
  // `owner/name` (no version) → /v1/models/owner/name/predictions.
  const hasVersion = info.modelRef.includes(":");
  const url = hasVersion
    ? `${REPLICATE_API}/predictions`
    : `${REPLICATE_API}/models/${info.modelRef}/predictions`;
  const body = hasVersion
    ? { version: info.modelRef.split(":")[1], input }
    : { input };

  log.info(
    {
      model: info.id,
      ref: info.modelRef,
      prompt: opts.prompt.slice(0, 80),
    },
    "starting Replicate prediction",
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Replicate create prediction → ${res.status}: ${text}`);
  }

  const prediction = (await res.json()) as { id: string };
  log.info(
    { predictionId: prediction.id, model: info.id },
    "prediction created; polling",
  );

  const imageUrl = await pollReplicate(prediction.id, token);
  log.info(
    { imageUrl, model: info.id },
    "Replicate generation complete",
  );
  return { url: imageUrl, mimeType: "image/png" };
}

async function callGoogle(
  info: ImageModelInfo,
  opts: GenerateImageOpts,
): Promise<GenerateImageResult> {
  const result = await generateGoogleImage(info, {
    prompt: opts.prompt,
    aspect: opts.aspect ?? "square",
    imageInput: opts.imageInput,
  });
  return { bytes: result.bytes, mimeType: result.mimeType };
}

async function callOpenAi(
  info: ImageModelInfo,
  opts: GenerateImageOpts,
): Promise<GenerateImageResult> {
  const result = await generateOpenAiImage(info, {
    prompt: opts.prompt,
    aspect: opts.aspect ?? "square",
  });
  return { bytes: result.bytes, mimeType: result.mimeType };
}

export async function generateImage(
  opts: GenerateImageOpts,
): Promise<GenerateImageResult> {
  const id = opts.model ?? DEFAULT_IMAGE_MODEL;
  const info =
    getImageModelInfo(id) ?? getImageModelInfo(DEFAULT_IMAGE_MODEL);
  if (!info) throw new Error(`No image model registered (looked up "${id}")`);

  if (opts.negativePrompt && !info.supportsNegativePrompt) {
    log.debug(
      { model: info.id },
      "negativePrompt ignored — model does not support it",
    );
  }
  if (opts.imageInput?.length && !info.supportsImageInput) {
    log.debug(
      { model: info.id },
      "imageInput ignored — model does not support it",
    );
  }

  switch (info.provider) {
    case "google":
      return callGoogle(info, opts);
    case "replicate":
      return callReplicate(info, opts);
    case "openai":
      return callOpenAi(info, opts);
  }
}
