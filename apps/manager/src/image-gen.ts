// Image generation via Replicate's Stable Diffusion API.
// Requires: REPLICATE_API_TOKEN in env.
// Docs: https://replicate.com/stability-ai/sdxl

import pino from "pino";

const log = pino({ name: "image-gen" });

const API = "https://api.replicate.com/v1";

// Default to SDXL — fast, high-quality 1:1 images ideal for social posts.
const DEFAULT_MODEL = "stability-ai/sdxl:39ed52f2319f9bf9f645afe1b76c5c4ff4d2fc18a408ef4ea6b5f1c2c7a97f1e";

export type GenerateImageOpts = {
  prompt: string;
  negativePrompt?: string;
  /** Aspect ratio hint: "square" | "portrait" | "landscape" */
  aspect?: "square" | "portrait" | "landscape";
  model?: string;
};

export type GenerateImageResult = {
  /** Public CDN URL for the generated image */
  url: string;
};

const ASPECT_DIMS: Record<string, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 1024, height: 1280 },
  landscape: { width: 1280, height: 1024 },
};

async function poll(predictionId: string, token: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${API}/predictions/${predictionId}`, {
      headers: { Authorization: `Token ${token}` },
    });
    const data = await res.json() as { status: string; output?: string[]; error?: string };
    if (data.status === "succeeded" && data.output?.[0]) return data.output[0];
    if (data.status === "failed") throw new Error(`Replicate prediction failed: ${data.error ?? "unknown"}`);
    // Wait 2s between polls (max ~2 minutes total).
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Replicate prediction timed out after 2 minutes");
}

export async function generateImage(opts: GenerateImageOpts): Promise<GenerateImageResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN must be set");

  const dims = ASPECT_DIMS[opts.aspect ?? "square"]!;
  const model = opts.model ?? DEFAULT_MODEL;

  log.info({ prompt: opts.prompt.slice(0, 80), model }, "starting Replicate prediction");

  const res = await fetch(`${API}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: model.includes(":") ? model.split(":")[1] : model,
      input: {
        prompt: opts.prompt,
        negative_prompt: opts.negativePrompt ?? "text, watermark, logo, blur, low quality",
        width: dims.width,
        height: dims.height,
        num_outputs: 1,
        scheduler: "K_EULER",
        num_inference_steps: 30,
        guidance_scale: 7.5,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Replicate create prediction → ${res.status}: ${text}`);
  }

  const prediction = await res.json() as { id: string };
  log.info({ predictionId: prediction.id }, "prediction created; polling");

  const imageUrl = await poll(prediction.id, token);
  log.info({ imageUrl }, "Replicate generation complete");
  return { url: imageUrl };
}
