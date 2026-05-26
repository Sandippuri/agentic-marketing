import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { generateVideo } from "@marketing/agents/video-gen";
import { uploadAssetBytes } from "@marketing/agents/asset-uploader";
import { buildBrandPromptPrefix } from "@marketing/agents/brand-prompt";
import { recordVideoUsage } from "@marketing/agents/usage";
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
import {
  getSignedAssetUrl,
  uploadAsset as uploadAssetBuffer,
} from "@/lib/supabase/storage";
import {
  contentTypeWantsVideo,
  resolveVideoModel,
  DEFAULT_VIDEO_MODEL,
  type VideoAspect,
  type VideoModel,
  type ContentType,
} from "@marketing/shared-types";

// Multi-clip video workflow. Producers cap one generation at ~8s, so this
// workflow plans 1..MAX_BEATS beats and chains them — each beat's last
// frame seeds the next beat's image-to-video input. Final stitched MP4
// is the only asset row that lands in the DB; intermediate clips live in
// Supabase under a `_tmp/` prefix and are dropped at the end of the run.
//
// Each phase is its own `"use step"` so the runtime can durably retry from
// the latest cached output instead of re-paying for upstream Veo / Sora
// / Replicate calls when a downstream step fails.

export type VideoVariantInput = {
  contentId: string;
  workspaceId: string;
  /**
   * When true, bypass BOTH the per-content needs_video flag and the
   * contentTypeWantsVideo() allowlist. Set by single-post when the user
   * explicitly picked media=video or media=both.
   */
  force?: boolean;
};

export type VideoVariantOutput = {
  inserted: number;
};

type LoadAndPlanOutput =
  | { skip: true; reason: string }
  | {
      skip: false;
      aspect: VideoAspect;
      model: VideoModel;
      firstFrameUrl: string | null;
      beats: VideoBeat[];
      scriptReasoning: string;
      totalSec: number;
    };

type GenerateBeatOutput = {
  /** Storage path of the just-generated clip MP4 (tmp prefix). */
  clipStoragePath: string;
  /**
   * Storage path of the JPEG holding this clip's last frame, signed-URL-
   * ready for the next beat. Null when extraction failed (next beat will
   * fall back to non-chained generation) or when this is the final beat.
   */
  lastFrameStoragePath: string | null;
};

type StitchOutput =
  | { ok: false; reason: string }
  | { ok: true; storagePath: string; durationSec: number };

const ASPECT_BY_TYPE: Record<string, VideoAspect> = {
  linkedin: "16:9",
  x_post: "16:9",
  x_thread: "16:9",
};

export async function videoVariantWorkflow(
  input: VideoVariantInput,
): Promise<VideoVariantOutput> {
  "use workflow";

  const plan = await loadAndPlanStep(input);
  if (plan.skip) {
    console.log(
      `[video-variant-workflow] skip ${input.contentId}: ${plan.reason}`,
    );
    return { inserted: 0 };
  }

  // Generate beats sequentially. Each beat is its own step so a Veo timeout
  // on beat 3 doesn't burn the cached output of beats 1 and 2 on retry.
  const clipStoragePaths: string[] = [];
  let nextFramePath: string | null = null;
  // firstFrameUrl is already a signed URL from loadAndPlanStep — generateBeatStep
  // will accept either a storage path (which it signs) or a pre-signed URL
  // (which it uses directly). We pass the initial URL via the `seedFrameUrl`
  // field on beat 1 only.
  for (let i = 0; i < plan.beats.length; i++) {
    const beat = plan.beats[i]!;
    const isFirst = i === 0;
    const isLast = i === plan.beats.length - 1;
    const beatResult = await generateBeatStep({
      contentId: input.contentId,
      workspaceId: input.workspaceId,
      beat,
      aspect: plan.aspect,
      model: plan.model,
      seedFrameUrl: isFirst ? plan.firstFrameUrl : null,
      priorLastFramePath: !isFirst ? nextFramePath : null,
      isLast,
    });
    if (!beatResult) {
      // Provider failed mid-script. Salvage upstream clips rather than
      // throwing the whole run away.
      console.warn(
        `[video-variant-workflow] beat ${beat.index} failed; stitching ${clipStoragePaths.length} clip(s) we already have`,
      );
      break;
    }
    clipStoragePaths.push(beatResult.clipStoragePath);
    nextFramePath = beatResult.lastFrameStoragePath;
  }

  if (clipStoragePaths.length === 0) {
    console.warn(
      `[video-variant-workflow] no clips generated for ${input.contentId}`,
    );
    return { inserted: 0 };
  }

  const stitched = await stitchAndUploadStep({
    contentId: input.contentId,
    clipStoragePaths,
  });
  if (!stitched.ok) {
    console.warn(
      `[video-variant-workflow] stitch failed for ${input.contentId}: ${stitched.reason}`,
    );
    return { inserted: 0 };
  }

  const inserted = await insertAssetStep({
    workspaceId: input.workspaceId,
    contentId: input.contentId,
    storagePath: stitched.storagePath,
    durationSec: stitched.durationSec,
    promptUsed: plan.beats
      .map(
        (b) =>
          `[beat ${b.index} / ${b.motionDescription}]\n${b.promptForVeo}`,
      )
      .join("\n\n"),
  });

  return { inserted };
}

// --- Step 1: load context + plan the script ------------------------------

async function loadAndPlanStep(
  input: VideoVariantInput,
): Promise<LoadAndPlanOutput> {
  "use step";
  const db = getDb();

  const [row] = await db
    .select({
      title: schema.contentItems.title,
      type: schema.contentItems.type,
      bodyMd: schema.contentItems.bodyMd,
      campaignId: schema.contentItems.campaignId,
      workspaceId: schema.contentItems.workspaceId,
      needsVideo: schema.contentItems.needsVideo,
      visualBrief: schema.contentItems.visualBrief,
    })
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, input.contentId))
    .limit(1);
  if (!row) {
    return { skip: true, reason: "content row not found" };
  }
  if (!input.force && row.needsVideo === false) {
    return { skip: true, reason: "needs_video=false (per-content opt-out)" };
  }
  if (!input.force && !contentTypeWantsVideo(row.type as ContentType)) {
    return {
      skip: true,
      reason: `contentType ${row.type} not in VIDEO_ENABLED_CONTENT_TYPES`,
    };
  }

  const settings = await readVideoSettings();
  if (!settings.enabled) {
    return { skip: true, reason: "video_generation_enabled=false" };
  }
  if (
    !process.env.GEMINI_API_KEY &&
    !process.env.OPENAI_API_KEY &&
    !process.env.REPLICATE_API_TOKEN
  ) {
    return {
      skip: true,
      reason:
        "no video provider API key set (GEMINI_API_KEY / OPENAI_API_KEY / REPLICATE_API_TOKEN)",
    };
  }

  const brief = (row.visualBrief as VisualConceptBrief | null) ?? null;
  const aspect = ASPECT_BY_TYPE[row.type] ?? "16:9";
  const firstFrameUrl = await findFirstFrameUrl(input.contentId);
  const brandCtx = await buildBrandPromptPrefix({
    medium: "video",
    workspaceId: input.workspaceId,
    campaignId: row.campaignId,
  });

  const firstImageMarker = extractFirstImageMarker(row.bodyMd);
  const subject = (row.title ?? "").slice(0, 240);

  console.log(
    `[video-variant-workflow] planning ${input.contentId} type=${row.type} aspect=${aspect} model=${settings.model} firstFrame=${firstFrameUrl ? "yes" : "no"} brief=${brief ? "yes" : "no"} brandPrefixChars=${brandCtx.prefix.length}`,
  );

  const script = await planVideoScript({
    subject,
    conceptSummary: brief?.concept_summary ?? null,
    motion: brief?.motion ?? null,
    brandPrefix: brandCtx.prefix,
    styleNotes: brief?.style_notes ?? null,
    bannedElements: brief?.banned_elements ?? null,
    firstImageMarker,
    hasFirstFrame: Boolean(firstFrameUrl),
  });

  console.log(
    `[video-variant-workflow] plan beats=${script.beats.length} totalSec=${script.totalSec} reason="${script.reasoning}"`,
  );

  return {
    skip: false,
    aspect,
    model: settings.model,
    firstFrameUrl,
    beats: script.beats,
    scriptReasoning: script.reasoning,
    totalSec: script.totalSec,
  };
}

// --- Step 2: generate ONE beat -------------------------------------------

async function generateBeatStep(payload: {
  contentId: string;
  workspaceId: string;
  beat: VideoBeat;
  aspect: VideoAspect;
  model: VideoModel;
  /** Signed URL for the very first beat (existing still on the content item). */
  seedFrameUrl: string | null;
  /** Storage path of the prior beat's last-frame JPEG. */
  priorLastFramePath: string | null;
  /** True when this is the last beat — skips last-frame extraction. */
  isLast: boolean;
}): Promise<GenerateBeatOutput | null> {
  "use step";

  // Resolve the image-to-video source. Beat 1 uses the existing still URL;
  // later beats use the prior beat's last frame uploaded to Supabase.
  let imageUrl: string | undefined;
  if (payload.seedFrameUrl) {
    imageUrl = payload.seedFrameUrl;
  } else if (payload.priorLastFramePath) {
    try {
      imageUrl = await getSignedAssetUrl(payload.priorLastFramePath);
    } catch (err) {
      console.warn(
        `[video-variant-workflow] failed to sign prior frame URL; falling back to text-only generation for beat ${payload.beat.index}:`,
        err instanceof Error ? err.message : err,
      );
      imageUrl = undefined;
    }
  }

  console.log(
    `[video-variant-workflow] generating beat ${payload.beat.index} for ${payload.contentId} (${payload.beat.motionDescription}) model=${payload.model} i2v=${Boolean(imageUrl)}`,
  );

  let clip;
  try {
    clip = await generateVideo({
      prompt: payload.beat.promptForVeo,
      aspect: payload.aspect,
      model: payload.model,
      imageUrl,
      durationSec: PER_BEAT_SECONDS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[video-variant-workflow] provider failed on beat ${payload.beat.index}:`,
      message,
    );
    // Persist to ai_usage so silent provider failures (Veo 400s, quota,
    // auth) are queryable instead of only living in the dev-server stdout.
    await recordVideoUsage({
      attribution: {
        agent: "video-variant",
        workspaceId: payload.workspaceId,
      },
      model: payload.model,
      durationSec: 0,
      error: `beat ${payload.beat.index}: ${message}`.slice(0, 1000),
      metadata: { contentId: payload.contentId, beatIndex: payload.beat.index },
    });
    return null;
  }

  // Stage the clip in Supabase Storage under a tmp prefix. We keep paths in
  // the step output (small) instead of clip bytes (huge) so the workflow
  // event log stays cheap to persist.
  const clipStoragePath = `_tmp/video-stitch/${payload.contentId}/clip-${payload.beat.index}-${crypto.randomUUID()}.mp4`;
  try {
    await uploadAssetBytes(clip.bytes, clip.mimeType, clipStoragePath);
  } catch (err) {
    console.warn(
      `[video-variant-workflow] clip upload failed on beat ${payload.beat.index}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  // Skip last-frame extraction on the final beat — there's no beat after it.
  if (payload.isLast) {
    return { clipStoragePath, lastFrameStoragePath: null };
  }

  let lastFrameStoragePath: string | null = null;
  try {
    const lastFrameBytes = await extractLastFrameJpeg(clip.bytes);
    lastFrameStoragePath = `_tmp/video-stitch/${payload.contentId}/last-${payload.beat.index}-${crypto.randomUUID()}.jpg`;
    await uploadAssetBuffer(
      lastFrameStoragePath,
      Buffer.from(lastFrameBytes),
      "image/jpeg",
    );
  } catch (err) {
    console.warn(
      `[video-variant-workflow] last-frame extraction/upload failed on beat ${payload.beat.index}; next beat will not chain:`,
      err instanceof Error ? err.message : err,
    );
    lastFrameStoragePath = null;
  }

  return { clipStoragePath, lastFrameStoragePath };
}

// --- Step 3: stitch & upload --------------------------------------------

async function stitchAndUploadStep(payload: {
  contentId: string;
  clipStoragePaths: string[];
}): Promise<StitchOutput> {
  "use step";

  // Pull every clip back into memory. For 4 beats x ~10MB this is well
  // within Vercel's per-request memory budget (~1 GB on default plans);
  // bumping past that would need streaming concat (out of scope here).
  const clipBytes: Uint8Array[] = [];
  for (const p of payload.clipStoragePaths) {
    try {
      const url = await getSignedAssetUrl(p);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        return { ok: false, reason: `clip download ${res.status} for ${p}` };
      }
      clipBytes.push(new Uint8Array(await res.arrayBuffer()));
    } catch (err) {
      return {
        ok: false,
        reason: `clip download threw for ${p}: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  let stitched;
  try {
    stitched = await concatMp4s(clipBytes);
  } catch (err) {
    return {
      ok: false,
      reason: `ffmpeg concat threw: ${err instanceof Error ? err.message : err}`,
    };
  }
  if (!stitched) {
    return { ok: false, reason: "concatMp4s returned null (empty clips)" };
  }

  const finalPath = `videos/${payload.contentId}/${crypto.randomUUID()}.mp4`;
  try {
    await uploadAssetBytes(stitched.bytes, "video/mp4", finalPath);
  } catch (err) {
    return {
      ok: false,
      reason: `final upload threw: ${err instanceof Error ? err.message : err}`,
    };
  }

  console.log(
    `[video-variant-workflow] stitched final MP4 for ${payload.contentId} clips=${clipBytes.length} durationSec=${stitched.durationSec} bytes=${stitched.bytes.length}`,
  );

  return {
    ok: true,
    storagePath: finalPath,
    durationSec: stitched.durationSec,
  };
}

// --- Step 4: insert the DB row ------------------------------------------

async function insertAssetStep(payload: {
  workspaceId: string;
  contentId: string;
  storagePath: string;
  durationSec: number;
  promptUsed: string;
}): Promise<number> {
  "use step";
  const db = getDb();
  await db.insert(schema.assets).values({
    workspaceId: payload.workspaceId,
    contentId: payload.contentId,
    kind: "video_post",
    storagePath: payload.storagePath,
    promptUsed: payload.promptUsed,
    mimeType: "video/mp4",
    durationSec: Math.round(payload.durationSec),
    status: "draft",
  });
  console.log(
    `[video-variant-workflow] inserted video asset for ${payload.contentId} path=${payload.storagePath} dur=${payload.durationSec}s`,
  );
  return 1;
}

// --- helpers ------------------------------------------------------------

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
    const enabled = enabledRow?.value === false ? false : true;
    return {
      enabled,
      model: resolveVideoModel(modelRow?.value),
    };
  } catch (err) {
    console.warn(
      `[video-variant-workflow] failed to read settings; using defaults`,
      err,
    );
    return { enabled: true, model: DEFAULT_VIDEO_MODEL };
  }
}

async function findFirstFrameUrl(contentId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ storagePath: schema.assets.storagePath, kind: schema.assets.kind })
    .from(schema.assets)
    .where(eq(schema.assets.contentId, contentId));
  const still = rows.find((r) => r.kind !== "video_post" && r.storagePath);
  if (!still) return null;
  try {
    return await getSignedAssetUrl(still.storagePath);
  } catch {
    return null;
  }
}

function extractFirstImageMarker(
  body: string | null | undefined,
): string | null {
  if (!body) return null;
  const match = body.match(/\[IMAGE(?:\s*\d+)?:\s*([^\]]+)\]/i);
  return match?.[1]?.trim() ?? null;
}
