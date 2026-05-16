/**
 * asset-pipeline workflow — the sole image-generation path.
 *
 * Post-0029 redesign: visual direction comes UPSTREAM from the Content agent
 * (per-post `imageBrief`) and the Strategist (campaign-level
 * `visualIdentity`). The Art Director runs as a refiner — it composes the
 * VisualConceptBrief deterministically from those inputs, no LLM call. We
 * generate ONE image, judge it, and retry once if the judge rejects.
 *
 * Why: the previous fanout-of-3 + LLM-driven concept synthesis cost ~$0.22
 * per post and produced generic visuals because the AD had to invent the
 * concept from the body alone. The new path costs ~$0.07 (or ~$0.13 worst
 * case with retry) and the image is grounded in what the writer actually
 * meant.
 *
 * Flow per run:
 *   1. load-context        — pull content_item (with imageBrief) and parent
 *                            campaign (with visualIdentity).
 *   2. art-direction       — runArtDirector in REFINER mode composes the
 *                            VisualConceptBrief from imageBrief + identity.
 *                            (Falls back to LLM synthesis if imageBrief is
 *                            missing — legacy paths.)
 *   3. translate-prompt    — concept-to-prompt produces ONE candidate (model
 *                            renders overlay text natively; no template
 *                            chrome step post-0029).
 *   4. generate            — single image-gen call.
 *   5. judge-and-retry     — vision-LLM scores the candidate. If rejected,
 *                            regenerate ONCE with the rejection reason fed
 *                            back into the prompt.
 *   6. upload-and-record   — upload accepted (or best-effort) image to
 *                            Supabase and insert one assets row.
 */
import { eq } from "drizzle-orm";
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
import { buildBrandPromptPrefix } from "@marketing/agents/brand-prompt";
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
   * Number of candidates to generate. Default 1 (post-0029 — see workflow
   * docstring). Pass >1 only for legacy / experimental fanout paths.
   */
  variantCount?: number;
  /** Override the AD/judge model (vision-capable required for judge). */
  judgeModel?: LlmModel;
};

export type AssetPipelineOutput = {
  contentId: string;
  briefSummary: string;
  candidatesGenerated: number;
  candidatesAccepted: number;
  winnerStoragePath: string | null;
  scores: Array<{
    index: number;
    verdict: "accept" | "reject";
    total: number;
    reason: string;
  }>;
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
  const brief = await artDirectionStep({
    workspaceId: input.workspaceId,
    contentId: input.contentId,
    request: ctx.request,
    contentBody: ctx.bodyMd,
    channel: ctx.channel,
    campaignId: ctx.campaignId,
    judgeModel: input.judgeModel,
    imageBrief: ctx.imageBrief,
    visualIdentity: ctx.visualIdentity,
  });
  // Persist the brief immediately so the fire-and-forget video kickoff (and
  // any other modality) reads from one source. Done as its own step so the
  // write is durable independent of downstream image-gen / judging.
  await persistBriefStep({ contentId: input.contentId, brief });

  const variantCount = input.variantCount ?? 1;
  const firstPass = await generatePassStep({
    workspaceId: input.workspaceId,
    contentId: input.contentId,
    brief,
    channel: ctx.channel,
    brandPrefix: ctx.brandPrefix,
    brandReferenceImages: ctx.brandReferenceImages,
    imageModel: ctx.imageModel,
    variantCount,
    passLabel: "v1",
  });
  let scores = await judgeStep({
    brief,
    candidates: firstPass,
    judgeModel: input.judgeModel,
    workspaceId: input.workspaceId,
  });
  let candidates = firstPass;

  // Retry-once-on-reject: if the judge rejected every candidate, regenerate
  // a single image with the rejection reason fed back into the prompt. This
  // is the only retry — we never spiral.
  const allRejected =
    scores.length > 0 && scores.every((s) => s.verdict === "reject");
  if (allRejected) {
    const reason = scores[0]?.reason ?? "candidate did not meet brief";
    const retryPass = await generatePassStep({
      workspaceId: input.workspaceId,
      contentId: input.contentId,
      brief,
      channel: ctx.channel,
      brandPrefix: ctx.brandPrefix,
      brandReferenceImages: ctx.brandReferenceImages,
      imageModel: ctx.imageModel,
      variantCount: 1,
      passLabel: "v2",
      retryReason: reason,
    });
    const retryScores = await judgeStep({
      brief,
      candidates: retryPass,
      judgeModel: input.judgeModel,
      workspaceId: input.workspaceId,
    });
    candidates = [...candidates, ...retryPass];
    scores = [...scores, ...retryScores];
  }

  const result = await uploadAndRecordStep({
    contentId: input.contentId,
    workspaceId: input.workspaceId,
    kind: ctx.kind,
    candidates,
    scores,
    brief,
  });
  return {
    contentId: input.contentId,
    briefSummary: brief.concept_summary,
    candidatesGenerated: candidates.length,
    candidatesAccepted: scores.filter((s) => s.verdict === "accept").length,
    winnerStoragePath: result.winnerStoragePath,
    scores: scores.map((s) => ({
      index: s.index,
      verdict: s.verdict,
      total: s.total ?? 0,
      reason: s.reason,
    })),
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
  // Signed URLs for brand logos. Passed as visual reference to the image
  // model so logos are PLACED, not redrawn. Previously dropped — the model
  // had to invent the mark from text, which is why it kept hallucinating
  // "Veru Fi" / wordmark variants.
  brandReferenceImages: string[];
  imageModel: ImageModel;
  imageBrief: ImageBrief | null;
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
      imageBrief: schema.contentItems.imageBrief,
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

  const { prefix: brandPrefix, referenceImages: brandReferenceImages } =
    await buildBrandPromptPrefix({
      medium: "image",
      workspaceId: input.workspaceId,
      campaignId: row.campaignId,
    });

  return {
    request: input.request ?? row.title,
    bodyMd: row.bodyMd ?? "",
    channel,
    kind,
    campaignId: row.campaignId,
    brandPrefix,
    brandReferenceImages,
    imageModel,
    imageBrief: (row.imageBrief as ImageBrief | null) ?? null,
    visualIdentity:
      (campaignRow?.visualIdentity as VisualIdentity | null) ?? null,
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
}): Promise<VisualConceptBrief> {
  "use step";
  const cp = buildCpClient();
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
  imageModel: ImageModel;
  variantCount: number;
  passLabel: string;
  retryReason?: string;
}): Promise<GeneratedCandidate[]> {
  "use step";
  const variants = conceptToVariants(args.brief, {
    brandPrefix: args.brandPrefix,
    brandReferenceImages: args.brandReferenceImages,
    channel: args.channel,
    variantCount: args.variantCount,
    retryReason: args.retryReason,
  });

  const results = await Promise.allSettled(
    variants.map(async (variant) => {
      const opts = variantToImageOpts(variant);
      const result = await generateImage({ ...opts, model: args.imageModel });

      let rawBytes: Uint8Array;
      if (result.bytes) {
        rawBytes = result.bytes;
      } else if (result.url) {
        const r = await fetch(result.url);
        if (!r.ok) throw new Error(`download generated image: ${r.status}`);
        rawBytes = new Uint8Array(await r.arrayBuffer());
      } else {
        throw new Error("generateImage returned neither bytes nor url");
      }

      const ext = (result.mimeType.split("/")[1] ?? "png").toLowerCase();
      // Path layout: `pipeline/<workspaceId>/<contentId>/<pass>-<index>.<ext>`.
      // Workspace segment at position 2 (1-indexed) keeps the Storage RLS
      // policy from PR 9 working without migration changes.
      const storagePath = `pipeline/${args.workspaceId}/${args.contentId}/${args.passLabel}-${variant.index}.${ext}`;
      await uploadGeneratedMedia(
        { bytes: rawBytes, mimeType: result.mimeType },
        storagePath,
      );

      // Sign the upload so the vision-LLM judge can read it. Best-effort —
      // if signing fails we still record the path; the judge just skips it.
      let signedUrl: string | null = null;
      try {
        signedUrl = await getSignedAssetUrl(storagePath);
      } catch {
        signedUrl = null;
      }
      return {
        // Disambiguate retry candidates so judge results don't collide on index.
        index: args.passLabel === "v1" ? variant.index : variant.index + 100,
        prompt: variant.prompt,
        storagePath,
        signedUrl,
        bytesUrl: null,
      };
    }),
  );

  const out: GeneratedCandidate[] = [];
  const failures: Array<{ index: number; reason: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      out.push(r.value);
    } else {
      const reason =
        r.reason instanceof Error
          ? `${r.reason.message}${r.reason.stack ? `\n${r.reason.stack}` : ""}`
          : String(r.reason);
      console.error(
        `[asset-pipeline] candidate ${variants[i]!.index} (${args.passLabel}) failed:`,
        reason,
      );
      failures.push({ index: variants[i]!.index, reason });
      out.push({
        index:
          args.passLabel === "v1" ? variants[i]!.index : variants[i]!.index + 100,
        prompt: variants[i]!.prompt,
        storagePath: null,
        signedUrl: null,
        bytesUrl: null,
      });
    }
  }
  if (out.every((c) => !c.storagePath)) {
    const summary = failures
      .map((f) => `[${f.index}] ${f.reason.split("\n")[0]}`)
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
  return runAssetJudge({
    brief: args.brief,
    candidates: judgeable.map((c) => ({
      index: c.index,
      imageUrl: c.signedUrl,
      prompt: c.prompt,
    })),
    workspaceId: args.workspaceId,
    model: args.judgeModel,
  });
}

async function uploadAndRecordStep(args: {
  contentId: string;
  workspaceId: string;
  kind: AssetKind;
  candidates: GeneratedCandidate[];
  scores: CandidateScore[];
  brief: VisualConceptBrief;
}): Promise<{ winnerStoragePath: string | null }> {
  "use step";
  const winner = pickWinner(args.scores);
  const db = getDb();

  // Insert all generated candidates as drafts. The winner gets promoted
  // (status=approved) so existing approval cards surface it first. Each row
  // carries the Judge's structured score so the learning loop (Phase D) can
  // query high-scoring assets without re-judging.
  const rows = args.candidates
    .filter((c) => c.storagePath)
    .map((c) => {
      const score = args.scores.find((s) => s.index === c.index);
      const isWinner = winner?.index === c.index;
      return {
        workspaceId: args.workspaceId,
        contentId: args.contentId,
        kind: args.kind,
        storagePath: c.storagePath!,
        promptUsed: c.prompt,
        status: (isWinner ? "approved" : "draft") as
          | "approved"
          | "draft",
        mimeType: "image/png",
        judgeScore: score ?? null,
        judgeTotal: score?.total != null ? String(score.total) : null,
        judgeVerdict: score?.verdict ?? null,
      };
    });

  if (rows.length > 0) {
    await db.insert(schema.assets).values(rows);
  }
  return {
    winnerStoragePath: winner
      ? args.candidates.find((c) => c.index === winner.index)?.storagePath ?? null
      : null,
  };
}

// ============================================================

function buildCpClient() {
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  return new CpClient({ baseUrl, internalToken });
}
