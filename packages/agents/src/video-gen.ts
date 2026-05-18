// Video generation dispatcher. Mirrors image-gen.ts but for video models.
//
// Provider → env var:
//   - google     → GEMINI_API_KEY  (Veo 3.1)
//   - openai     → OPENAI_API_KEY  (Sora 2 / Sora 2 Pro)
//   - replicate  → REPLICATE_API_TOKEN  (Wan 2.6 t2v / i2v, others)

import pino from "pino";
import {
  DEFAULT_VIDEO_MODEL,
  getVideoModelInfo,
  type VideoAspect,
  type VideoModel,
} from "@marketing/shared-types";
import { generateGoogleVideo } from "./providers/google-video";
import { generateOpenAiVideo } from "./providers/openai-video";
import { generateReplicateVideo } from "./providers/replicate-video";

const log = pino({ name: "video-gen" });

export type GenerateVideoOpts = {
  prompt: string;
  aspect?: VideoAspect;
  durationSec?: number;
  /** First-frame image URL — switches Veo into image-to-video mode. */
  imageUrl?: string;
  withAudio?: boolean;
  model?: VideoModel;
};

export type GenerateVideoResult = {
  bytes: Uint8Array;
  mimeType: string;
  durationSec: number;
};

export async function generateVideo(
  opts: GenerateVideoOpts,
): Promise<GenerateVideoResult> {
  const id = opts.model ?? DEFAULT_VIDEO_MODEL;
  const info =
    getVideoModelInfo(id) ?? getVideoModelInfo(DEFAULT_VIDEO_MODEL);
  if (!info) throw new Error(`No video model registered (looked up "${id}")`);

  log.info(
    { model: info.id, aspect: opts.aspect, duration: opts.durationSec },
    "video generate dispatching",
  );

  switch (info.provider) {
    case "google":
      return generateGoogleVideo(info, {
        prompt: opts.prompt,
        aspect: opts.aspect,
        durationSec: opts.durationSec,
        imageUrl: opts.imageUrl,
        withAudio: opts.withAudio,
      });
    case "openai":
      return generateOpenAiVideo(info, {
        prompt: opts.prompt,
        aspect: opts.aspect,
        durationSec: opts.durationSec,
        imageUrl: opts.imageUrl,
        withAudio: opts.withAudio,
      });
    case "replicate":
      return generateReplicateVideo(info, {
        prompt: opts.prompt,
        aspect: opts.aspect,
        durationSec: opts.durationSec,
        imageUrl: opts.imageUrl,
        withAudio: opts.withAudio,
      });
  }
}
