// Native OpenAI Sora 2 video generation.
//
// Sora is asynchronous: POST /v1/videos returns a job id, GET /v1/videos/{id}
// is polled until status="completed", then GET /v1/videos/{id}/content
// streams the MP4 bytes. Image-to-video requires uploading the first-frame
// image to the Files API first and passing input_reference.file_id.

import pino from "pino";
import type { VideoModelInfo, VideoAspect } from "@marketing/shared-types";

const log = pino({ name: "openai-video" });
const API_BASE = "https://api.openai.com/v1";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 8 * 60 * 1_000; // Sora pro 1080p clips can run long.

// 16:9 / 9:16 → exact pixel sizes. Sora rejects anything off-list and
// also requires the input_reference image to match the target size exactly.
const SIZE_BY_MODEL: Record<string, Record<VideoAspect, string>> = {
  "sora-2": {
    "16:9": "1280x720",
    "9:16": "720x1280",
  },
  "sora-2-pro": {
    "16:9": "1920x1080",
    "9:16": "1080x1920",
  },
};

export type OpenAiVideoOpts = {
  prompt: string;
  aspect?: VideoAspect;
  durationSec?: number;
  /** Optional first-frame image URL. Triggers image-to-video via Files API. */
  imageUrl?: string;
  withAudio?: boolean;
};

export type OpenAiVideoResult = {
  bytes: Uint8Array;
  mimeType: string;
  durationSec: number;
};

type VideoJob = {
  id: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  progress?: number;
  error?: { code?: string; message?: string } | string;
  seconds?: string;
  size?: string;
};

type FileUpload = { id: string; object: string; bytes: number };

async function uploadInputReference(
  apiKey: string,
  imageUrl: string,
): Promise<string> {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(
      `Failed to fetch first-frame image ${imageUrl}: ${imgRes.status}`,
    );
  }
  const mimeType = imgRes.headers.get("content-type") ?? "image/png";
  const buf = Buffer.from(await imgRes.arrayBuffer());

  // OpenAI Files API requires multipart/form-data with a `purpose` field.
  // `vision` is the documented purpose for image references used by /v1/videos.
  const form = new FormData();
  const ext = mimeType.split("/")[1]?.split(";")[0] || "png";
  form.append("purpose", "vision");
  form.append(
    "file",
    new Blob([buf], { type: mimeType }),
    `input_reference.${ext}`,
  );

  const res = await fetch(`${API_BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI Files upload ${res.status}: ${text}`);
  }
  const json = (await res.json()) as FileUpload;
  if (!json.id) throw new Error("OpenAI Files upload returned no id");
  return json.id;
}

function resolveSize(modelRef: string, aspect: VideoAspect): string {
  const table = SIZE_BY_MODEL[modelRef] ?? SIZE_BY_MODEL["sora-2"]!;
  return table[aspect];
}

function resolveSeconds(durationSec: number | undefined, fallback: number): string {
  // Sora accepts "4", "8", or "12" as strings on sora-2; pro also accepts longer.
  // Snap whatever the caller asked for to the nearest allowed bucket.
  const allowed = [4, 8, 12];
  const d = durationSec ?? fallback;
  const nearest = allowed.reduce((a, b) =>
    Math.abs(b - d) < Math.abs(a - d) ? b : a,
  );
  return String(nearest);
}

export async function generateOpenAiVideo(
  info: VideoModelInfo,
  opts: OpenAiVideoOpts,
): Promise<OpenAiVideoResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY must be set to use the OpenAI video provider (Sora)",
    );
  }

  const aspect = opts.aspect ?? "16:9";
  const size = resolveSize(info.modelRef, aspect);
  const seconds = resolveSeconds(opts.durationSec, info.defaultDurationSec);

  const body: Record<string, unknown> = {
    model: info.modelRef,
    prompt: opts.prompt,
    size,
    seconds,
  };

  if (opts.imageUrl && info.supportsImageToVideo) {
    const fileId = await uploadInputReference(apiKey, opts.imageUrl);
    body.input_reference = { file_id: fileId };
  }

  log.info(
    {
      model: info.modelRef,
      size,
      seconds,
      i2v: Boolean(opts.imageUrl),
      promptHead: opts.prompt.slice(0, 80),
    },
    "Sora: creating video job",
  );

  const startRes = await fetch(`${API_BASE}/videos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(`Sora create ${startRes.status}: ${text}`);
  }
  const job = (await startRes.json()) as VideoJob;
  if (!job.id) throw new Error("Sora create returned no job id");

  log.info({ jobId: job.id }, "Sora: polling job");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let final: VideoJob | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(`${API_BASE}/videos/${job.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => "");
      throw new Error(`Sora poll ${pollRes.status}: ${text}`);
    }
    const cur = (await pollRes.json()) as VideoJob;
    if (cur.status === "completed" || cur.status === "failed") {
      final = cur;
      break;
    }
  }
  if (!final) {
    throw new Error(
      `Sora job did not finish within ${POLL_TIMEOUT_MS / 1000}s`,
    );
  }
  if (final.status === "failed") {
    const msg =
      typeof final.error === "string"
        ? final.error
        : (final.error?.message ?? JSON.stringify(final.error));
    throw new Error(`Sora job failed: ${msg}`);
  }

  log.info({ jobId: final.id }, "Sora: downloading content");

  const dlRes = await fetch(
    `${API_BASE}/videos/${final.id}/content?variant=video`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!dlRes.ok) {
    const text = await dlRes.text().catch(() => "");
    throw new Error(`Sora download ${dlRes.status}: ${text}`);
  }
  const mimeType = dlRes.headers.get("content-type") ?? "video/mp4";
  const buf = await dlRes.arrayBuffer();

  return {
    bytes: new Uint8Array(buf),
    mimeType,
    durationSec: Number(final.seconds ?? seconds),
  };
}
