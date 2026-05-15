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
import type { VisualConceptBrief } from "@marketing/agents/sub-agents/art-director";
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

/**
 * Build a Veo prompt that EXPLAINS the post's concept through motion. When a
 * persisted Art Director brief is available, its motion fields drive each
 * beat (the brief was authored against the same content the image generator
 * just illustrated, so still + clip reinforce one another). When no brief is
 * present — older content rows, or runs where the AD step failed — we fall
 * back to a generic 3-beat scaffold seeded from the subject + image marker.
 */
function buildVeoPrompt(args: {
  subject: string;
  marker: string | null;
  hasFirstFrame: boolean;
  brandPrefix: string;
  brief: VisualConceptBrief | null;
}): string {
  const subject = args.subject.slice(0, 200).trim();
  const anchor = args.hasFirstFrame
    ? `Begin from the provided first frame and animate FROM that exact composition — preserve the existing color, lighting, and element placement; do not re-stage the scene.`
    : `Open on a clean establishing composition that mirrors a poster still.`;

  const motion = args.brief?.motion;
  const hasMotion = Boolean(
    motion && (motion.opening_state || motion.reveal_beat || motion.settling_state),
  );

  const beats = hasMotion
    ? [
        `Beat 1 (0–2s): ${motion!.opening_state || "the scene settles; key elements animate in subtly."}`,
        `Beat 2 (2–6s): ${motion!.reveal_beat || "the core idea is revealed through motion — make the concept legible through movement, not decoration."}`,
        `Beat 3 (6–8s): ${motion!.settling_state || "motion eases out; the frame settles on a clean final composition."}`,
        `Camera: ${motion!.camera || "a single intentional move — no jump cuts, no rapid pans, no shaky-cam."}`,
      ]
    : [
        `Beat 1 (0–2s): the scene settles; the key elements animate in subtly (lines glow, tokens nudge into place, layers fade up — pick what fits the concept).`,
        `Beat 2 (2–6s): the core idea is revealed through motion — flows converge, paths branch, layers stack, or before/after toggles. MAKE IT LEGIBLE through movement, not decoration.`,
        `Beat 3 (6–8s): motion eases out and the frame settles on a clean final composition that could be the post's hero still.`,
        `Camera: a single, intentional move (gentle push-in, slow orbit, or smooth parallax) — no jump cuts, no rapid pans, no shaky-cam.`,
      ];

  const concept = args.brief?.concept_summary
    ? args.brief.concept_summary.slice(0, 320)
    : (args.marker ?? args.subject).slice(0, 320).trim();

  const stylePieces: string[] = [];
  if (args.brief?.style_notes) stylePieces.push(args.brief.style_notes.slice(0, 200));
  stylePieces.push(
    "Brand-clean palette, subtle film grain, soft volumetric light. No on-screen text, no logos, no captions, no watermarks, no UI chrome.",
  );

  const bannedExtras = args.brief?.banned_elements?.length
    ? args.brief.banned_elements.slice(0, 8).join(", ")
    : "";
  const bannedLine = bannedExtras
    ? `Avoid: generic particle drifts, abstract glowing blobs, anonymous floating cubes, rainbow gradients, wireframe globes, arches on pedestals, lone abstract objects, ${bannedExtras}.`
    : `Avoid: generic particle drifts, abstract glowing blobs, anonymous floating cubes, rainbow gradients, wireframe globes, arches on pedestals, lone abstract objects.`;

  const lines = [
    `An ~8 second concept-explainer clip that visualizes: ${subject}.`,
    `Visual concept the clip must make clear: ${concept}.`,
    anchor,
    ...beats,
    `Style: ${stylePieces.join(" ")}`,
    bannedLine,
  ];
  const body = lines.join(" ");
  return args.brandPrefix ? `${args.brandPrefix}${body}` : body;
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
  const [imageUrl, brief, brandCtx] = await Promise.all([
    findFirstFrameUrl(input.contentId),
    loadVisualBrief(input.contentId),
    buildBrandPromptPrefix({
      medium: "video",
      campaignId: input.campaignId ?? null,
    }),
  ]);
  const prompt = buildVeoPrompt({
    subject: input.subject,
    marker: input.firstImageMarker ?? null,
    hasFirstFrame: Boolean(imageUrl),
    brandPrefix: brandCtx.prefix,
    brief,
  });

  console.log(
    `[video-variant] generating Veo clip for ${input.contentId} type=${input.contentType} aspect=${aspect} model=${model} i2v=${Boolean(imageUrl)} brandPrefixChars=${brandCtx.prefix.length} brief=${brief ? "yes" : "no"}`,
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
    workspaceId: input.workspaceId,
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
