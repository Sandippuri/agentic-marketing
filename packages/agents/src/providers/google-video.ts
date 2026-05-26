// Native Google Veo 3.1 video generation.
//
// Veo is asynchronous: POST :predictLongRunning → operation name → poll the
// operation until `done`. Each operation contains a list of generated videos
// referencing a `file.uri`; that file must be downloaded with the API key
// appended as ?key=… to land its bytes locally.

import pino from "pino";
import type { VideoModelInfo, VideoAspect } from "@marketing/shared-types";

const log = pino({ name: "google-video" });
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Veo's API caps: 4–8s clips. We default to 8 (set in shared-types).
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 4 * 60 * 1_000; // 4 min hard cap.

export type GoogleVideoOpts = {
  prompt: string;
  aspect?: VideoAspect;
  durationSec?: number;
  /** Optional first-frame image (URL or base64 data URL). Triggers image-to-video. */
  imageUrl?: string;
  /** Hint to enable Veo's audio track. Default true. */
  withAudio?: boolean;
};

export type GoogleVideoResult = {
  bytes: Uint8Array;
  mimeType: string;
  durationSec: number;
};

type Operation = {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{
        video?: { uri?: string; mimeType?: string };
      }>;
    };
  };
};

async function fetchInlineImage(
  url: string,
): Promise<{ mimeType: string; bytesBase64Encoded: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch first-frame image ${url}: ${res.status}`);
  }
  const mimeType = res.headers.get("content-type") ?? "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, bytesBase64Encoded: buf.toString("base64") };
}

export async function generateGoogleVideo(
  info: VideoModelInfo,
  opts: GoogleVideoOpts,
): Promise<GoogleVideoResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY must be set to use the native Google video provider",
    );
  }

  const aspect = opts.aspect ?? "16:9";
  const duration = Math.max(4, Math.min(opts.durationSec ?? info.defaultDurationSec, 8));

  const instance: Record<string, unknown> = { prompt: opts.prompt };
  if (opts.imageUrl) {
    instance.image = await fetchInlineImage(opts.imageUrl);
  }

  const wantsAudio = opts.withAudio === true && info.supportsAudio;
  const body = {
    instances: [instance],
    parameters: {
      aspectRatio: aspect,
      durationSeconds: duration,
      // Only send generateAudio when the caller explicitly opts in — preview
      // models reject the parameter outright with INVALID_ARGUMENT.
      ...(wantsAudio ? { generateAudio: true } : {}),
      // personGeneration intentionally omitted: the API rejects both
      // "dont_allow" and "allow_adult" with INVALID_ARGUMENT on most
      // projects/regions. Omitting it is universally accepted.
      sampleCount: 1,
    },
  };

  log.info(
    {
      model: info.modelRef,
      aspect,
      duration,
      i2v: Boolean(opts.imageUrl),
      promptHead: opts.prompt.slice(0, 80),
    },
    "Veo: starting predictLongRunning",
  );

  const startUrl = `${API_BASE}/models/${info.modelRef}:predictLongRunning?key=${encodeURIComponent(apiKey)}`;
  const startRes = await fetch(startUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(`Veo predictLongRunning ${startRes.status}: ${text}`);
  }
  const op = (await startRes.json()) as Operation;
  if (!op.name) {
    throw new Error("Veo predictLongRunning returned no operation name");
  }

  log.info({ op: op.name }, "Veo: polling operation");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  // The `name` field is already a path like "models/.../operations/<id>".
  const pollUrl = `${API_BASE}/${op.name}?key=${encodeURIComponent(apiKey)}`;
  let final: Operation | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(pollUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => "");
      throw new Error(`Veo poll ${pollRes.status}: ${text}`);
    }
    const cur = (await pollRes.json()) as Operation;
    if (cur.done) {
      final = cur;
      break;
    }
  }
  if (!final) {
    throw new Error(
      `Veo operation did not complete within ${POLL_TIMEOUT_MS / 1000}s`,
    );
  }
  if (final.error) {
    throw new Error(
      `Veo failed: ${final.error.message ?? JSON.stringify(final.error)}`,
    );
  }

  const sample = final.response?.generateVideoResponse?.generatedSamples?.[0];
  const fileUri = sample?.video?.uri;
  if (!fileUri) {
    throw new Error("Veo response missing video.uri");
  }
  const mimeType = sample?.video?.mimeType ?? "video/mp4";

  // The file URI requires the API key appended for download authentication.
  const downloadUrl = fileUri.includes("?")
    ? `${fileUri}&key=${encodeURIComponent(apiKey)}`
    : `${fileUri}?key=${encodeURIComponent(apiKey)}`;

  log.info({ downloadUrl: downloadUrl.split("?")[0] }, "Veo: downloading file");

  const dlRes = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!dlRes.ok) {
    const text = await dlRes.text().catch(() => "");
    throw new Error(`Veo download ${dlRes.status}: ${text}`);
  }
  const buf = await dlRes.arrayBuffer();

  return {
    bytes: new Uint8Array(buf),
    mimeType,
    durationSec: duration,
  };
}
