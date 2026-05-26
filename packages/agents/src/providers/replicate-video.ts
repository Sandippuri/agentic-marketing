// Replicate-backed video generation. Currently wired for Wan 2.6 (t2v + i2v),
// but the dispatch is generic on `info.modelRef` so any future Replicate
// video model with a similar input shape can plug in without code changes.
//
// Replicate predictions are asynchronous: create returns a prediction id,
// poll /v1/predictions/{id} until status="succeeded", read the MP4 URL out
// of `output`, then fetch the bytes.

import pino from "pino";
import type { VideoModelInfo, VideoAspect } from "@marketing/shared-types";

const log = pino({ name: "replicate-video" });
const REPLICATE_API = "https://api.replicate.com/v1";

// Wan video models can take a while at 1080p; we cap generously.
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 8 * 60 * 1_000;

// Wan duration choices are discrete: 5 / 10 / 15 seconds.
const WAN_DURATIONS = [5, 10, 15];

export type ReplicateVideoOpts = {
  prompt: string;
  aspect?: VideoAspect;
  durationSec?: number;
  /** Required for i2v variants. Ignored for t2v. */
  imageUrl?: string;
  withAudio?: boolean;
  negativePrompt?: string;
  seed?: number;
};

export type ReplicateVideoResult = {
  bytes: Uint8Array;
  mimeType: string;
  durationSec: number;
};

type Prediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string;
};

function snapDuration(input: number | undefined, fallback: number): number {
  const d = input ?? fallback;
  return WAN_DURATIONS.reduce((a, b) =>
    Math.abs(b - d) < Math.abs(a - d) ? b : a,
  );
}

function buildWanInput(
  info: VideoModelInfo,
  opts: ReplicateVideoOpts,
): Record<string, unknown> {
  const aspect = opts.aspect ?? "16:9";
  const duration = snapDuration(opts.durationSec, info.defaultDurationSec);

  const input: Record<string, unknown> = {
    prompt: opts.prompt,
    aspect_ratio: aspect,
    resolution: "1080p",
    duration,
    audio: opts.withAudio !== false && info.supportsAudio,
  };
  if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt;
  if (typeof opts.seed === "number") input.seed = opts.seed;
  if (info.supportsImageToVideo) {
    if (!opts.imageUrl) {
      throw new Error(
        `${info.id} is an image-to-video model — an imageUrl is required`,
      );
    }
    input.image = opts.imageUrl;
  }
  return input;
}

async function pollPrediction(
  predictionId: string,
  token: string,
): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${REPLICATE_API}/predictions/${predictionId}`, {
      headers: { Authorization: `Token ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as Prediction;
    if (data.status === "succeeded" && data.output) {
      const url = Array.isArray(data.output) ? data.output[0] : data.output;
      if (url) return url;
    }
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(
        `Replicate prediction ${data.status}: ${data.error ?? "unknown"}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Replicate prediction timed out after ${POLL_TIMEOUT_MS / 1000}s`,
  );
}

export async function generateReplicateVideo(
  info: VideoModelInfo,
  opts: ReplicateVideoOpts,
): Promise<ReplicateVideoResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error(
      "REPLICATE_API_TOKEN must be set to use Replicate video providers",
    );
  }

  const input = buildWanInput(info, opts);

  // `owner/name:version` → /v1/predictions with `version`.
  // `owner/name` (latest) → /v1/models/owner/name/predictions.
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
      aspect: input.aspect_ratio,
      duration: input.duration,
      i2v: info.supportsImageToVideo,
      promptHead: opts.prompt.slice(0, 80),
    },
    "Replicate video: creating prediction",
  );

  const startRes = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(`Replicate create ${startRes.status}: ${text}`);
  }
  const prediction = (await startRes.json()) as Prediction;
  if (!prediction.id) {
    throw new Error("Replicate create returned no prediction id");
  }

  log.info({ predictionId: prediction.id }, "Replicate video: polling");

  const videoUrl = await pollPrediction(prediction.id, token);

  log.info({ videoUrl }, "Replicate video: downloading");

  const dlRes = await fetch(videoUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!dlRes.ok) {
    const text = await dlRes.text().catch(() => "");
    throw new Error(`Replicate video download ${dlRes.status}: ${text}`);
  }
  const mimeType = dlRes.headers.get("content-type") ?? "video/mp4";
  const buf = await dlRes.arrayBuffer();

  return {
    bytes: new Uint8Array(buf),
    mimeType,
    durationSec: Number(input.duration),
  };
}
