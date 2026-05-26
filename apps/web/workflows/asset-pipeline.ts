/**
 * asset-pipeline workflow — the sole image-generation path.
 *
 * Post-0029 / migration 0040: visual direction comes UPSTREAM from the Content
 * agent (per-post `imageBriefs[]` — array of 1–4) and the Strategist
 * (campaign-level `visualIdentity`). The Art Director runs as a refiner — it
 * composes one VisualConceptBrief per slot deterministically from those
 * inputs. We generate ONE image per slot, judge each, and retry-once on
 * reject. Slots run in parallel.
 *
 * Why N images: many posts (carousels, before/after, multi-stat) carry
 * distinct visual information across multiple images. Until 0040 the pipeline
 * was hard-locked to one; now each slot is independent.
 *
 * Per-slot regeneration: pass `slotIndex` to regenerate exactly one slot
 * without touching the others. The approval UI's "regenerate this image"
 * button uses this; full-post resubmission omits it to regenerate every slot.
 *
 * Flow per run:
 *   1. load-context        — pull content_item (with imageBriefs[]) and
 *                            parent campaign (with visualIdentity).
 *   2. per slot (parallel):
 *      a. art-direction       — runArtDirector in REFINER mode composes the
 *                               slot's VisualConceptBrief.
 *      b. translate-prompt    — concept-to-prompt produces ONE candidate
 *                               (model renders overlay text natively).
 *      c. generate            — single image-gen call.
 *      d. judge-and-retry     — vision-LLM scores the candidate. If
 *                               rejected, regenerate ONCE with the rejection
 *                               reason fed back into the prompt.
 *   3. persist-lead-brief  — write slot-0's VisualConceptBrief to
 *                            content_items.visual_brief so the video pipeline
 *                            (single-frame i2v) reads from one canonical
 *                            source. Slot 0 is the lead/cover by convention.
 *   4. upload-and-record   — insert one assets row per candidate with the
 *                            correct sequence_order; promote one winner per
 *                            slot to status=approved.
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { runArtDirector, type VisualConceptBrief } from "@marketing/agents/sub-agents/art-director";
import type { ImageBrief } from "@marketing/agents/sub-agents/content";
import type { VisualIdentity } from "@marketing/agents/sub-agents/strategist";
import {
  conceptToVariants,
  variantToImageOpts,
} from "@marketing/agents/concept-to-prompt";
import { runAssetJudge, pickWinner, type CandidateScore } from "@marketing/agents/asset-judge";
import { generateImage } from "@marketing/agents/image-gen";
import { uploadGeneratedMedia } from "@marketing/agents/asset-uploader";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import sharp from "sharp";
import {
  buildBrandPromptPrefix,
  type PartnerLogoReference,
} from "@marketing/agents/brand-prompt";
import { CpClient } from "@marketing/cp-client";
import {
  resolveImageModel,
  type AssetKind,
  type ImageModel,
  type LlmModel,
} from "@marketing/shared-types";

export type AssetPipelineInput = {
  /** Workspace scope; mandatory from PR 4. Threaded via dispatchStart. */
  workspaceId: string;
  contentId: string;
  /** Optional override; otherwise drawn from content_items.title. */
  request?: string;
  /** When set, used to override the channel inferred from content_items.type. */
  channel?: string;
  /**
   * Number of candidates per slot. Default 1 (post-0029 — judge picks the
   * single best). Pass >1 only for legacy / experimental fanout paths.
   */
  variantCount?: number;
  /**
   * When set, the pipeline runs ONLY this slot (and demotes any
   * previously-approved asset at the same slot). Use case: per-slot
   * regeneration triggered from the approval UI. When omitted, every slot
   * in imageBriefs[] runs.
   */
  slotIndex?: number;
  /** Override the AD/judge model (vision-capable required for judge). */
  judgeModel?: LlmModel;
  /**
   * Storage path of a user-uploaded inspiration image. When set, it's signed
   * and passed to the image model as an additional reference (placed after
   * brand logos), and the prompt is augmented to instruct style-match while
   * keeping the brand's actual subject. See /api/uploads/inspiration-images.
   */
  inspirationImagePath?: string;
};

export type AssetPipelineOutput = {
  contentId: string;
  slotsProcessed: number;
  candidatesGenerated: number;
  candidatesAccepted: number;
  winnersBySlot: Array<{ slotIndex: number; storagePath: string | null }>;
  briefSummaries: string[];
};

const KIND_BY_TYPE: Record<string, { kind: AssetKind; channel: string }> = {
  blog: { kind: "og", channel: "internal_blog" },
  linkedin: { kind: "poster", channel: "linkedin" },
  x_post: { kind: "poster", channel: "x" },
  x_thread: { kind: "poster", channel: "x" },
  email: { kind: "email_header", channel: "email_hubspot" },
};

export async function assetPipelineWorkflow(
  input: AssetPipelineInput,
): Promise<AssetPipelineOutput> {
  "use workflow";

  const ctx = await loadContextStep(input);

  // Determine which slots to process. Per-slot regen passes slotIndex; full
  // runs process every entry in imageBriefs[]. If the array is empty (legacy
  // row not migrated, or content_items pre-dating image briefs), fall back
  // to a single null-brief slot so the Art Director's LLM-synthesis path
  // still produces something.
  const briefs: Array<ImageBrief | null> = ctx.imageBriefs.length
    ? ctx.imageBriefs
    : [null];
  const slotIndices =
    input.slotIndex != null
      ? [input.slotIndex]
      : briefs.map((_, i) => i);

  // If we're regenerating a single slot, demote any previously-approved
  // asset at that slot so uploadAndRecordStep's new winner becomes
  // unambiguously canonical. (Full-post regens have their own demotion path
  // in single-post.ts; per-slot regens own this here.)
  if (input.slotIndex != null) {
    await demoteSlotAssetsStep({
      contentId: input.contentId,
      slotIndex: input.slotIndex,
    });
  }

  const variantCount = input.variantCount ?? 1;

  // Run every slot in parallel. Each slot is independent: its own art
  // direction, its own generation, its own judge, its own retry. The
  // workflow runtime treats each step call as a separate durable event.
  const slotResults = await Promise.all(
    slotIndices.map(async (slotIndex) => {
      const brief = briefs[slotIndex] ?? null;
      const visualBrief = await artDirectionStep({
        workspaceId: input.workspaceId,
        contentId: input.contentId,
        request: ctx.request,
        contentBody: ctx.bodyMd,
        channel: ctx.channel,
        campaignId: ctx.campaignId,
        judgeModel: input.judgeModel,
        imageBrief: brief,
        visualIdentity: ctx.visualIdentity,
        slotIndex,
      });

      const firstPass = await generatePassStep({
        workspaceId: input.workspaceId,
        contentId: input.contentId,
        brief: visualBrief,
        channel: ctx.channel,
        brandPrefix: ctx.brandPrefix,
        brandReferenceImages: ctx.brandReferenceImages,
        inspirationReferenceImages: ctx.inspirationReferenceImages,
        imageModel: ctx.imageModel,
        variantCount,
        passLabel: `v1-s${slotIndex}`,
      });
      let scores = await judgeStep({
        brief: visualBrief,
        candidates: firstPass,
        judgeModel: input.judgeModel,
        workspaceId: input.workspaceId,
      });
      let candidates = firstPass;

      const allRejected =
        scores.length > 0 && scores.every((s) => s.verdict === "reject");
      if (allRejected) {
        const reason = scores[0]?.reason ?? "candidate did not meet brief";
        const retryPass = await generatePassStep({
          workspaceId: input.workspaceId,
          contentId: input.contentId,
          brief: visualBrief,
          channel: ctx.channel,
          brandPrefix: ctx.brandPrefix,
          brandReferenceImages: ctx.brandReferenceImages,
          inspirationReferenceImages: ctx.inspirationReferenceImages,
          imageModel: ctx.imageModel,
          variantCount: 1,
          passLabel: `v2-s${slotIndex}`,
          retryReason: reason,
        });
        const retryScores = await judgeStep({
          brief: visualBrief,
          candidates: retryPass,
          judgeModel: input.judgeModel,
          workspaceId: input.workspaceId,
        });
        candidates = [...candidates, ...retryPass];
        scores = [...scores, ...retryScores];
      }

      return { slotIndex, visualBrief, candidates, scores };
    }),
  );

  // Persist slot-0's visualBrief — the video workflow consumes this as the
  // single-frame i2v starting point and only needs the lead. (Multi-image
  // visual_brief storage would require schema change; slot-0 is "good
  // enough" since carousels share visual identity.)
  const leadResult = slotResults.find((r) => r.slotIndex === 0);
  if (leadResult) {
    await persistBriefStep({
      contentId: input.contentId,
      brief: leadResult.visualBrief,
    });
  }

  const recordResults = await uploadAndRecordStep({
    contentId: input.contentId,
    workspaceId: input.workspaceId,
    kind: ctx.kind,
    slots: slotResults.map((r) => ({
      slotIndex: r.slotIndex,
      candidates: r.candidates,
      scores: r.scores,
    })),
  });

  const candidatesGenerated = slotResults.reduce(
    (sum, r) => sum + r.candidates.length,
    0,
  );
  const candidatesAccepted = slotResults.reduce(
    (sum, r) => sum + r.scores.filter((s) => s.verdict === "accept").length,
    0,
  );

  return {
    contentId: input.contentId,
    slotsProcessed: slotResults.length,
    candidatesGenerated,
    candidatesAccepted,
    winnersBySlot: recordResults.winnersBySlot,
    briefSummaries: slotResults.map((r) => r.visualBrief.concept_summary),
  };
}

// ============================================================
// Steps
// ============================================================

type LoadedContext = {
  request: string;
  bodyMd: string;
  channel: string;
  kind: AssetKind;
  campaignId: string;
  brandPrefix: string;
  brandReferenceImages: string[];
  inspirationReferenceImages: string[];
  imageModel: ImageModel;
  imageBriefs: ImageBrief[];
  visualIdentity: VisualIdentity | null;
};

async function loadContextStep(
  input: AssetPipelineInput,
): Promise<LoadedContext> {
  "use step";
  const db = getDb();
  const [row] = await db
    .select({
      title: schema.contentItems.title,
      bodyMd: schema.contentItems.bodyMd,
      type: schema.contentItems.type,
      campaignId: schema.contentItems.campaignId,
      imageBriefs: schema.contentItems.imageBriefs,
    })
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, input.contentId))
    .limit(1);
  if (!row) throw new Error(`content not found: ${input.contentId}`);

  const fallbackChannel = KIND_BY_TYPE[row.type]?.channel ?? "linkedin";
  const channel = input.channel ?? fallbackChannel;
  const kind = KIND_BY_TYPE[row.type]?.kind ?? "poster";

  const [settingsRow, campaignRow] = await Promise.all([
    db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "image_model"))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({ visualIdentity: schema.campaigns.visualIdentity })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, row.campaignId))
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  const imageModel = resolveImageModel(settingsRow?.value);

  const visualIdentity = (campaignRow?.visualIdentity as VisualIdentity | null) ?? null;
  const partnerLogos: PartnerLogoReference[] = [];
  for (const logo of visualIdentity?.partner_logos ?? []) {
    try {
      const url = await getSignedAssetUrl(logo.storagePath);
      if (url) partnerLogos.push({ url, label: logo.label });
    } catch {
      // skip — signing failed
    }
  }

  const { prefix: brandPrefix, referenceImages: brandReferenceImages } =
    await buildBrandPromptPrefix({
      medium: "image",
      workspaceId: input.workspaceId,
      campaignId: row.campaignId,
      partnerLogos,
    });

  let inspirationReferenceImages: string[] = [];
  if (input.inspirationImagePath) {
    try {
      const signed = await getSignedAssetUrl(input.inspirationImagePath);
      if (signed) inspirationReferenceImages = [signed];
    } catch {
      inspirationReferenceImages = [];
    }
  }

  // Normalize imageBriefs to an array. Migration 0040 backfilled single-
  // object rows into [{...}], so this is mostly a typing concern — but guard
  // against `null` (post created with images turned off) by treating it as
  // an empty array; the workflow body falls back to one null-brief slot.
  const rawBriefs = row.imageBriefs as unknown;
  const imageBriefs: ImageBrief[] = Array.isArray(rawBriefs)
    ? (rawBriefs as ImageBrief[])
    : [];

  return {
    request: input.request ?? row.title,
    bodyMd: row.bodyMd ?? "",
    channel,
    kind,
    campaignId: row.campaignId,
    brandPrefix,
    brandReferenceImages,
    inspirationReferenceImages,
    imageModel,
    imageBriefs,
    visualIdentity,
  };
}

async function artDirectionStep(args: {
  workspaceId: string;
  contentId: string;
  request: string;
  contentBody: string;
  channel: string;
  campaignId: string;
  judgeModel?: LlmModel;
  imageBrief: ImageBrief | null;
  visualIdentity: VisualIdentity | null;
  slotIndex: number;
}): Promise<VisualConceptBrief> {
  "use step";
  const cp = buildCpClient(args.workspaceId);
  return runArtDirector({
    request: args.request,
    workspaceId: args.workspaceId,
    contentBody: args.contentBody,
    channel: args.channel,
    campaignId: args.campaignId,
    cp,
    model: args.judgeModel,
    imageBrief: args.imageBrief,
    visualIdentity: args.visualIdentity,
  });
}

async function persistBriefStep(args: {
  contentId: string;
  brief: VisualConceptBrief;
}): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .update(schema.contentItems)
    .set({ visualBrief: args.brief })
    .where(eq(schema.contentItems.id, args.contentId));
}

async function demoteSlotAssetsStep(args: {
  contentId: string;
  slotIndex: number;
}): Promise<void> {
  "use step";
  const db = getDb();
  // Per-slot demotion: only touches the target slot. Other slots' approved
  // assets stay approved so the carousel doesn't lose them while we
  // regenerate this one.
  await db
    .update(schema.assets)
    .set({ status: "draft", updatedAt: new Date() })
    .where(
      and(
        eq(schema.assets.contentId, args.contentId),
        eq(schema.assets.sequenceOrder, args.slotIndex),
        eq(schema.assets.status, "approved"),
      ),
    );
}

type GeneratedCandidate = {
  index: number;
  prompt: string;
  storagePath: string | null;
  signedUrl: string | null;
  bytesUrl: string | null;
};

/**
 * Translate the brief into prompts and generate the images in one step. The
 * passLabel + retryReason let the retry pass run again with the same shape
 * but a tightened prompt, while keeping each pass as a single durable step.
 *
 * Post-0029: no template renderer. The image model paints overlay text
 * itself when brief.slots.headline is set (see concept-to-prompt.ts).
 */
async function generatePassStep(args: {
  workspaceId: string;
  contentId: string;
  brief: VisualConceptBrief;
  channel: string;
  brandPrefix: string;
  brandReferenceImages: string[];
  inspirationReferenceImages: string[];
  imageModel: ImageModel;
  variantCount: number;
  passLabel: string;
  retryReason?: string;
}): Promise<GeneratedCandidate[]> {
  "use step";
  const variants = await conceptToVariants(args.brief, {
    brandPrefix: args.brandPrefix,
    brandReferenceImages: args.brandReferenceImages,
    inspirationReferenceImages: args.inspirationReferenceImages,
    channel: args.channel,
    variantCount: args.variantCount,
    retryReason: args.retryReason,
  });

  const passDiscriminator = crypto.randomUUID().slice(0, 8);

  const results = await Promise.allSettled(
    variants.map(async (variant) => {
      const opts = variantToImageOpts(variant);
      const result = await generateImage({ ...opts, model: args.imageModel });

      let rawBytes: Uint8Array;
      if (result.bytes) {
        rawBytes = result.bytes;
      } else if (result.url) {
        const r = await fetch(result.url, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) throw new Error(`download generated image: ${r.status}`);
        rawBytes = new Uint8Array(await r.arrayBuffer());
      } else {
        throw new Error("generateImage returned neither bytes nor url");
      }

      const ext = (result.mimeType.split("/")[1] ?? "png").toLowerCase();
      // Path layout includes the slot-tagged passLabel so a regen of slot 2
      // doesn't overwrite slot 0's files. Without this, the assets table
      // accumulates rows that all point at the same path.
      const storagePath = `pipeline/${args.workspaceId}/${args.contentId}/${args.passLabel}-${variant.index}-${passDiscriminator}.${ext}`;
      await uploadGeneratedMedia(
        { bytes: rawBytes, mimeType: result.mimeType },
        storagePath,
      );

      let signedUrl: string | null = null;
      try {
        signedUrl = await getSignedAssetUrl(storagePath);
      } catch {
        signedUrl = null;
      }
      return {
        index: variant.index,
        prompt: variant.prompt,
        storagePath,
        signedUrl,
        bytesUrl: null,
      };
    }),
  );

  const out: GeneratedCandidate[] = [];
  const failures: Array<{ index: number; message: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      out.push(r.value);
    } else {
      const message =
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      const detail =
        r.reason instanceof Error && r.reason.stack
          ? `${message}\n${r.reason.stack}`
          : message;
      console.error(
        `[asset-pipeline] candidate ${variants[i]!.index} (${args.passLabel}) failed:`,
        detail,
      );
      failures.push({ index: variants[i]!.index, message });
      out.push({
        index: variants[i]!.index,
        prompt: variants[i]!.prompt,
        storagePath: null,
        signedUrl: null,
        bytesUrl: null,
      });
    }
  }
  if (out.every((c) => !c.storagePath)) {
    const summary = failures
      .map((f) => `[${f.index}] ${f.message.replace(/\s+/g, " ").trim()}`)
      .join("; ");
    throw new Error(
      `All ${variants.length} image candidates failed (${args.passLabel}): ${summary}`,
    );
  }
  return out;
}

async function judgeStep(args: {
  brief: VisualConceptBrief;
  candidates: GeneratedCandidate[];
  judgeModel?: LlmModel;
  workspaceId: string;
}): Promise<CandidateScore[]> {
  "use step";
  const judgeable = args.candidates.filter(
    (c): c is GeneratedCandidate & { signedUrl: string } => Boolean(c.signedUrl),
  );
  if (judgeable.length === 0) return [];

  // Downscale candidates to ~1024px before the vision call. Replicate stills
  // are typically 2-8MB at native res; Anthropic re-encodes server-side and
  // latency tracks payload size. A scoring rubric doesn't need full-res — the
  // judge looks for composition, subject, and palette, all preserved at 1024.
  // Falls back to the signed URL on fetch/decode failure so a bad image just
  // gets judged as-is rather than failing the whole step.
  const prepared = await Promise.all(
    judgeable.map(async (c) => {
      const fallback = { index: c.index, imageUrl: c.signedUrl, prompt: c.prompt };
      try {
        const res = await fetch(c.signedUrl, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return fallback;
        const buf = Buffer.from(await res.arrayBuffer());
        const resized = await sharp(buf)
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        return {
          index: c.index,
          imageUrl: `data:image/jpeg;base64,${resized.toString("base64")}`,
          prompt: c.prompt,
        };
      } catch {
        return fallback;
      }
    }),
  );

  return runAssetJudge({
    brief: args.brief,
    candidates: prepared,
    workspaceId: args.workspaceId,
    model: args.judgeModel,
  });
}

async function uploadAndRecordStep(args: {
  contentId: string;
  workspaceId: string;
  kind: AssetKind;
  slots: Array<{
    slotIndex: number;
    candidates: GeneratedCandidate[];
    scores: CandidateScore[];
  }>;
}): Promise<{
  winnersBySlot: Array<{ slotIndex: number; storagePath: string | null }>;
}> {
  "use step";
  const db = getDb();
  const winnersBySlot: Array<{ slotIndex: number; storagePath: string | null }> = [];

  // One winner per slot. Rows are inserted with sequence_order = slotIndex
  // so the approval UI can group them by slot and the publish layer can
  // order them.
  const rows: Array<typeof schema.assets.$inferInsert> = [];
  for (const slot of args.slots) {
    const winner = pickWinner(slot.scores);
    const winnerPath = winner
      ? slot.candidates.find((c) => c.index === winner.index)?.storagePath ?? null
      : null;
    winnersBySlot.push({ slotIndex: slot.slotIndex, storagePath: winnerPath });

    for (const c of slot.candidates) {
      if (!c.storagePath) continue;
      const score = slot.scores.find((s) => s.index === c.index);
      const isWinner = winner?.index === c.index;
      rows.push({
        workspaceId: args.workspaceId,
        contentId: args.contentId,
        kind: args.kind,
        storagePath: c.storagePath,
        promptUsed: c.prompt,
        status: isWinner ? "approved" : "draft",
        mimeType: "image/png",
        judgeScore: score ?? null,
        judgeTotal: score?.total != null ? String(score.total) : null,
        judgeVerdict: score?.verdict ?? null,
        sequenceOrder: slot.slotIndex,
      });
    }
  }

  if (rows.length > 0) {
    await db.insert(schema.assets).values(rows);
  }
  return { winnersBySlot };
}

// ============================================================

function buildCpClient(workspaceId?: string) {
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  return new CpClient({ baseUrl, internalToken, workspaceId });
}
