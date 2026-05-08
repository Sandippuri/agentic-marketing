// Generates a single ~8s promotional video for a content item using Veo 3.1
// and inserts an `assets` row of kind="video_post". Designed to be called
// fire-and-forget after still-image variants finish; failures are logged but
// never re-thrown.
//
// Veo is slow (30s–2min). Vercel `after()` defers work via waitUntil, but on
// Hobby plans that's capped — if you outgrow that, push this to the
// distributor's BullMQ assetQueue (TODO: future Phase).

import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { generateVideo } from "@marketing/agents/video-gen";
import { uploadAssetBytes } from "@marketing/agents/asset-uploader";
import { buildBrandPromptPrefix } from "@marketing/agents/brand-prompt";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import {
  contentTypeWantsVideo,
  resolveVideoModel,
  DEFAULT_VIDEO_MODEL,
  type VideoAspect,
  type VideoModel,
  type ContentType,
} from "@marketing/shared-types";

// X favors 16:9 in-feed; LinkedIn vertical posts favor 9:16. Default to 16:9
// because that's the safer cross-channel choice — vertical reposts crop fine
// from 16:9 but the reverse loses content.
const ASPECT_BY_TYPE: Record<string, VideoAspect> = {
  linkedin: "16:9",
  x_post: "16:9",
  x_thread: "16:9",
};

// Default: ON when a Gemini key is present. The settings row can flip it off
// if the team wants to disable Veo billing without unsetting the env var.
async function readVideoSettings(): Promise<{
  enabled: boolean;
  model: VideoModel;
}> {
  try {
    const db = getDb();
    const [enabledRow] = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "video_generation_enabled"))
      .limit(1);
    const [modelRow] = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "video_model"))
      .limit(1);
    // Treat missing row as "default on". Only an explicit `false` disables it.
    const enabled = enabledRow?.value === false ? false : true;
    return {
      enabled,
      model: resolveVideoModel(modelRow?.value),
    };
  } catch (err) {
    console.warn(`[video-variant] failed to read settings; using defaults`, err);
    return { enabled: true, model: DEFAULT_VIDEO_MODEL };
  }
}

// Pick the most recent still image attached to the content item, if any, so
// Veo can use it as the first frame (image-to-video). Returns null if no
// still has been uploaded yet.
async function findFirstFrameUrl(contentId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ storagePath: schema.assets.storagePath, kind: schema.assets.kind })
    .from(schema.assets)
    .where(eq(schema.assets.contentId, contentId));
  // Prefer poster/og/hero — anything image-shaped — and skip videos.
  const still = rows.find(
    (r) => r.kind !== "video_post" && r.storagePath,
  );
  if (!still) return null;
  try {
    return await getSignedAssetUrl(still.storagePath);
  } catch {
    return null;
  }
}

export type GenerateVideoVariantInput = {
  contentId: string;
  contentType: string;
  subject: string;
  /** Most informative IMAGE marker pulled from the body, if any. */
  firstImageMarker?: string | null;
  /** Campaign id for campaign-scoped brand overrides. */
  campaignId?: string | null;
};

export async function generateVideoVariant(
  input: GenerateVideoVariantInput,
): Promise<{ inserted: number }> {
  if (!contentTypeWantsVideo(input.contentType as ContentType)) {
    return { inserted: 0 };
  }

  const { enabled, model } = await readVideoSettings();
  if (!enabled) {
    console.log(
      `[video-variant] disabled for ${input.contentId} (set settings.video_generation_enabled=true to opt in)`,
    );
    return { inserted: 0 };
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      `[video-variant] GEMINI_API_KEY not set; skipping video for ${input.contentId}`,
    );
    return { inserted: 0 };
  }

  const aspect = ASPECT_BY_TYPE[input.contentType] ?? "16:9";

  // Veo prompt: lean on the inline IMAGE marker when present (richer creative
  // direction) and otherwise riff on the post subject. Keep it under 500 chars
  // — Veo prefers concrete, motion-aware prompts.
  const motion = input.firstImageMarker
    ? input.firstImageMarker.slice(0, 320)
    : input.subject.slice(0, 240);
  const basePrompt = [
    `A short cinematic promotional clip (~8 seconds) for: ${input.subject.slice(0, 200)}.`,
    `Visual direction: ${motion}.`,
    `Smooth camera motion. Brand-clean palette, subtle grain.`,
    `No on-screen text, no logos, no captions, no watermarks.`,
  ].join(" ");

  // Inject brand context server-side so Veo follows the same palette / mood
  // rules as still images. Falls through silently when no brand docs exist.
  const { prefix: brandPrefix } = await buildBrandPromptPrefix({
    medium: "video",
    campaignId: input.campaignId ?? null,
  });
  const prompt = brandPrefix ? `${brandPrefix}${basePrompt}` : basePrompt;

  const imageUrl = await findFirstFrameUrl(input.contentId);

  console.log(
    `[video-variant] generating Veo clip for ${input.contentId} type=${input.contentType} aspect=${aspect} model=${model} i2v=${Boolean(imageUrl)} brandPrefixChars=${brandPrefix.length}`,
  );

  let result;
  try {
    result = await generateVideo({
      prompt,
      aspect,
      model,
      imageUrl: imageUrl ?? undefined,
    });
  } catch (err) {
    console.warn(
      `[video-variant] Veo failed for ${input.contentId}:`,
      err instanceof Error ? err.message : err,
    );
    return { inserted: 0 };
  }

  const ext = (result.mimeType.split("/")[1] ?? "mp4").toLowerCase();
  const storagePath = `videos/${input.contentId}/${crypto.randomUUID()}.${ext}`;

  try {
    await uploadAssetBytes(result.bytes, result.mimeType, storagePath);
  } catch (err) {
    console.warn(
      `[video-variant] upload failed for ${input.contentId}:`,
      err instanceof Error ? err.message : err,
    );
    return { inserted: 0 };
  }

  const db = getDb();
  await db.insert(schema.assets).values({
    contentId: input.contentId,
    kind: "video_post",
    storagePath,
    promptUsed: prompt,
    mimeType: result.mimeType,
    durationSec: result.durationSec,
    status: "draft",
  });

  console.log(
    `[video-variant] inserted video asset for ${input.contentId} (${result.durationSec}s, ${result.bytes.length} bytes)`,
  );
  return { inserted: 1 };
}
