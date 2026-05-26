// Multi-clip video generation for a content item.
//
// Single video providers (Veo, Sora, Replicate) all cap one generation at
// ~8 seconds. This module orchestrates the chunk-and-stitch flow that
// produces a longer concept-explainer clip without that ceiling being
// visible to the user:
//
//   1. planVideoScript() → LLM picks 1..MAX_BEATS x 8s beats.
//   2. For each beat in order, call generateVideo() once. Clip 1 uses the
//      existing still as `imageUrl` (image-to-video); clip N>1 uses the
//      previous clip's LAST FRAME so motion + lighting carry across cuts.
//   3. concatMp4s() stitches every beat into one MP4.
//   4. One assets row lands in the DB — the intermediate clips never become
//      visible assets; they live in /tmp for the run only.
//
// The model dispatch happens inside generateVideo(), so this orchestrator
// is provider-agnostic. Veo, Sora, and Replicate all flow through the same
// code path; only `resolveVideoModel()` decides which one runs.

import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { generateVideo } from "@marketing/agents/video-gen";
import { uploadAssetBytes } from "@marketing/agents/asset-uploader";
import { buildBrandPromptPrefix } from "@marketing/agents/brand-prompt";
import {
  planVideoScript,
  PER_BEAT_SECONDS,
  type VideoBeat,
} from "@marketing/agents/video-script-planner";
import {
  concatMp4s,
  extractLastFrameJpeg,
} from "@marketing/agents/video-stitch";
import type { VisualConceptBrief } from "@marketing/agents/sub-agents/art-director";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { uploadAsset as uploadAssetBuffer } from "@/lib/supabase/storage";
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

async function loadVisualBrief(
  contentId: string,
): Promise<VisualConceptBrief | null> {
  try {
    const db = getDb();
    const [row] = await db
      .select({ visualBrief: schema.contentItems.visualBrief })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, contentId))
      .limit(1);
    return (row?.visualBrief as VisualConceptBrief | null) ?? null;
  } catch (err) {
    console.warn(
      `[video-variant] failed to load visual brief for ${contentId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// Pick the most recent still image attached to the content item, if any, so
// the first beat can use it as the first frame (image-to-video). Returns
// null if no still has been uploaded yet.
async function findFirstFrameUrl(contentId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ storagePath: schema.assets.storagePath, kind: schema.assets.kind })
    .from(schema.assets)
    .where(eq(schema.assets.contentId, contentId));
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
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  /**
   * When true, bypass the VIDEO_ENABLED_CONTENT_TYPES allowlist. Used when
   * the user explicitly picked "video" / "both" at submit — they're aware
   * the channel doesn't normally get video and want it anyway.
   */
  force?: boolean;
};

export async function generateVideoVariant(
  input: GenerateVideoVariantInput,
): Promise<{ inserted: number }> {
  // Loud logging at every gate so a missing video on the approval card has
  // an obvious "why" in the server logs.
  if (!input.force && !contentTypeWantsVideo(input.contentType as ContentType)) {
    console.log(
      `[video-variant] gate: contentType ${input.contentType} not in VIDEO_ENABLED_CONTENT_TYPES and force=false — skipping ${input.contentId}`,
    );
    return { inserted: 0 };
  }

  const { enabled, model } = await readVideoSettings();
  if (!enabled) {
    console.log(
      `[video-variant] gate: video_generation_enabled=false — skipping ${input.contentId}`,
    );
    return { inserted: 0 };
  }
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.REPLICATE_API_TOKEN) {
    console.warn(
      `[video-variant] gate: no video-provider API key set (GEMINI_API_KEY / OPENAI_API_KEY / REPLICATE_API_TOKEN) — skipping ${input.contentId}`,
    );
    return { inserted: 0 };
  }

  const aspect = ASPECT_BY_TYPE[input.contentType] ?? "16:9";
  const [firstFrameUrl, brief, brandCtx] = await Promise.all([
    findFirstFrameUrl(input.contentId),
    loadVisualBrief(input.contentId),
    buildBrandPromptPrefix({
      medium: "video",
      workspaceId: input.workspaceId,
      campaignId: input.campaignId ?? null,
    }),
  ]);

  console.log(
    `[video-variant] starting ${input.contentId} type=${input.contentType} aspect=${aspect} model=${model} firstFrame=${firstFrameUrl ? "yes" : "no"} brief=${brief ? "yes" : "no"} brandPrefixChars=${brandCtx.prefix.length}`,
  );

  // Plan the script. LLM decides 1..MAX_BEATS based on concept complexity.
  let script;
  try {
    script = await planVideoScript({
      subject: input.subject,
      conceptSummary: brief?.concept_summary ?? null,
      motion: brief?.motion ?? null,
      brandPrefix: brandCtx.prefix,
      styleNotes: brief?.style_notes ?? null,
      bannedElements: brief?.banned_elements ?? null,
      firstImageMarker: input.firstImageMarker ?? null,
      hasFirstFrame: Boolean(firstFrameUrl),
    });
  } catch (err) {
    console.warn(
      `[video-variant] planner threw for ${input.contentId}:`,
      err instanceof Error ? err.message : err,
    );
    return { inserted: 0 };
  }
  console.log(
    `[video-variant] plan ${input.contentId} beats=${script.beats.length} totalSec=${script.totalSec} reason="${script.reasoning}"`,
  );

  // Generate each beat sequentially. Each beat after the first uses the
  // previous beat's last frame as `imageUrl`, which is what makes the cuts
  // invisible in the final stitched video.
  const clipBytes: Uint8Array[] = [];
  let nextImageUrl: string | null = firstFrameUrl;
  for (const beat of script.beats) {
    const result = await generateOneBeat({
      contentId: input.contentId,
      beat,
      aspect,
      model,
      imageUrl: nextImageUrl,
    });
    if (!result) {
      // Provider failed mid-script. Salvage whatever we already have rather
      // than throwing away the upstream clips.
      console.warn(
        `[video-variant] beat ${beat.index}/${script.beats.length} failed for ${input.contentId} — stitching ${clipBytes.length} clip(s) we already have`,
      );
      break;
    }
    clipBytes.push(result.bytes);

    // If there are more beats, extract this beat's last frame and stage it
    // as a signed URL the NEXT provider call can fetch. We stage into the
    // Supabase assets bucket under a `_tmp/` prefix so the URL is reachable
    // from Veo / Sora / Replicate (they all need a publicly-fetchable URL).
    const isLast = beat.index === script.beats.length;
    if (!isLast) {
      try {
        const lastFrameBytes = await extractLastFrameJpeg(result.bytes);
        const lastFramePath = `_tmp/video-stitch/${input.contentId}/beat-${beat.index}-${crypto.randomUUID()}.jpg`;
        await uploadAssetBuffer(
          lastFramePath,
          Buffer.from(lastFrameBytes),
          "image/jpeg",
        );
        nextImageUrl = await getSignedAssetUrl(lastFramePath);
      } catch (err) {
        console.warn(
          `[video-variant] last-frame extraction failed for ${input.contentId} beat ${beat.index}; next beat will not chain:`,
          err instanceof Error ? err.message : err,
        );
        nextImageUrl = null;
      }
    }
  }

  if (clipBytes.length === 0) {
    console.warn(
      `[video-variant] no clips generated for ${input.contentId} — nothing to upload`,
    );
    return { inserted: 0 };
  }

  // Stitch the beats into one MP4.
  let stitched;
  try {
    stitched = await concatMp4s(clipBytes);
  } catch (err) {
    console.warn(
      `[video-variant] stitch failed for ${input.contentId}:`,
      err instanceof Error ? err.message : err,
    );
    return { inserted: 0 };
  }
  if (!stitched) {
    console.warn(`[video-variant] stitch returned null for ${input.contentId}`);
    return { inserted: 0 };
  }

  const storagePath = `videos/${input.contentId}/${crypto.randomUUID()}.mp4`;
  try {
    await uploadAssetBytes(stitched.bytes, "video/mp4", storagePath);
  } catch (err) {
    console.warn(
      `[video-variant] upload failed for ${input.contentId}:`,
      err instanceof Error ? err.message : err,
    );
    return { inserted: 0 };
  }

  // Persist a single asset row covering the whole stitched video. The
  // promptUsed field stores the planner's beat list (joined) so observability
  // can answer "what prompt produced this video".
  const promptUsed = script.beats
    .map((b) => `[beat ${b.index} / ${b.motionDescription}]\n${b.promptForVeo}`)
    .join("\n\n");

  const db = getDb();
  await db.insert(schema.assets).values({
    workspaceId: input.workspaceId,
    contentId: input.contentId,
    kind: "video_post",
    storagePath,
    promptUsed,
    mimeType: "video/mp4",
    durationSec: Math.round(stitched.durationSec),
    status: "draft",
  });

  console.log(
    `[video-variant] inserted stitched video asset for ${input.contentId} (${clipBytes.length} beats, ${Math.round(stitched.durationSec)}s, ${stitched.bytes.length} bytes)`,
  );
  return { inserted: 1 };
}

async function generateOneBeat(args: {
  contentId: string;
  beat: VideoBeat;
  aspect: VideoAspect;
  model: VideoModel;
  imageUrl: string | null;
}): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  console.log(
    `[video-variant] generating beat ${args.beat.index} for ${args.contentId} (${args.beat.motionDescription}) model=${args.model} i2v=${Boolean(args.imageUrl)}`,
  );
  try {
    const result = await generateVideo({
      prompt: args.beat.promptForVeo,
      aspect: args.aspect,
      model: args.model,
      imageUrl: args.imageUrl ?? undefined,
      durationSec: PER_BEAT_SECONDS,
    });
    return { bytes: result.bytes, mimeType: result.mimeType };
  } catch (err) {
    console.warn(
      `[video-variant] provider failed on beat ${args.beat.index} for ${args.contentId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
