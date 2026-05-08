/**
 * asset-pipeline workflow — Phase 2.5 replacement for the single-shot image
 * generation that fed today's "anonymous floating cube" outputs.
 *
 * Flow per run:
 *   1. art-direction       — runArtDirector emits a structured concept brief
 *                            grounded in KB visual_reference + product +
 *                            brand collections.
 *   2. translate-prompt    — concept-to-prompt produces N candidate variants
 *                            with banned-aesthetic negative prompts and
 *                            reference image URLs.
 *   3. generate-candidates — fan out N image-gen calls in parallel, each
 *                            with imageInput passed through to providers
 *                            that support reference conditioning.
 *   4. judge               — vision-LLM scores every candidate, rejects the
 *                            generic ones, picks a winner.
 *   5. upload-and-record   — uploads the winner (and runners-up) to Supabase
 *                            and inserts assets rows.
 *
 * The existing asset-variants.ts path stays intact — this workflow is opted
 * in via `ASSET_PIPELINE=1` (or per-call). Once verified the legacy path
 * gets retired in Phase 4.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { runArtDirector, type VisualConceptBrief } from "@marketing/agents/sub-agents/art-director";
import {
  conceptToVariants,
  variantToImageOpts,
  type CandidateVariant,
} from "@marketing/agents/concept-to-prompt";
import { runAssetJudge, pickWinner, type CandidateScore } from "@marketing/agents/asset-judge";
import { generateImage } from "@marketing/agents/image-gen";
import { uploadGeneratedMedia } from "@marketing/agents/asset-uploader";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { buildBrandPromptPrefix } from "@marketing/agents/brand-prompt";
import {
  resolveImageModel,
  type AssetKind,
  type ImageModel,
  type LlmModel,
} from "@marketing/shared-types";

export type AssetPipelineInput = {
  contentId: string;
  /** Optional override; otherwise drawn from content_items.title. */
  request?: string;
  /** When set, used to override the channel inferred from content_items.type. */
  channel?: string;
  /** Number of candidates to generate. Default 3. */
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
    contentId: input.contentId,
    request: ctx.request,
    contentBody: ctx.bodyMd,
    channel: ctx.channel,
    campaignId: ctx.campaignId,
    judgeModel: input.judgeModel,
  });
  const variants = await translatePromptStep({
    brief,
    channel: ctx.channel,
    brandPrefix: ctx.brandPrefix,
    variantCount: input.variantCount ?? 3,
  });
  const candidates = await generateCandidatesStep({
    contentId: input.contentId,
    variants,
    imageModel: ctx.imageModel,
  });
  const scores = await judgeStep({
    brief,
    candidates,
    judgeModel: input.judgeModel,
  });
  const result = await uploadAndRecordStep({
    contentId: input.contentId,
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
  imageModel: ImageModel;
};

async function loadContextStep(input: AssetPipelineInput): Promise<LoadedContext> {
  "use step";
  const db = getDb();
  const [row] = await db
    .select({
      title: schema.contentItems.title,
      bodyMd: schema.contentItems.bodyMd,
      type: schema.contentItems.type,
      campaignId: schema.contentItems.campaignId,
    })
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, input.contentId))
    .limit(1);
  if (!row) throw new Error(`content not found: ${input.contentId}`);

  const fallbackChannel = KIND_BY_TYPE[row.type]?.channel ?? "linkedin";
  const channel = input.channel ?? fallbackChannel;
  const kind = KIND_BY_TYPE[row.type]?.kind ?? "poster";

  const [settingsRow] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, "image_model"))
    .limit(1);
  const imageModel = resolveImageModel(settingsRow?.value);

  const { prefix: brandPrefix } = await buildBrandPromptPrefix({
    medium: "image",
    campaignId: row.campaignId,
  });

  return {
    request: input.request ?? row.title,
    bodyMd: row.bodyMd ?? "",
    channel,
    kind,
    campaignId: row.campaignId,
    brandPrefix,
    imageModel,
  };
}

async function artDirectionStep(args: {
  contentId: string;
  request: string;
  contentBody: string;
  channel: string;
  campaignId: string;
  judgeModel?: LlmModel;
}): Promise<VisualConceptBrief> {
  "use step";
  const cp = buildCpClient();
  return runArtDirector({
    request: args.request,
    contentBody: args.contentBody,
    channel: args.channel,
    campaignId: args.campaignId,
    cp,
    model: args.judgeModel,
  });
}

async function translatePromptStep(args: {
  brief: VisualConceptBrief;
  channel: string;
  brandPrefix: string;
  variantCount: number;
}): Promise<CandidateVariant[]> {
  "use step";
  return conceptToVariants(args.brief, {
    brandPrefix: args.brandPrefix,
    channel: args.channel,
    variantCount: args.variantCount,
  });
}

type GeneratedCandidate = {
  index: number;
  prompt: string;
  storagePath: string | null;
  signedUrl: string | null;
  bytesUrl: string | null;
};

async function generateCandidatesStep(args: {
  contentId: string;
  variants: CandidateVariant[];
  imageModel: ImageModel;
}): Promise<GeneratedCandidate[]> {
  "use step";
  const results = await Promise.allSettled(
    args.variants.map(async (variant) => {
      const opts = variantToImageOpts(variant);
      const result = await generateImage({ ...opts, model: args.imageModel });
      const ext = (result.mimeType.split("/")[1] ?? "png").toLowerCase();
      const { storagePath } = await uploadGeneratedMedia(
        result,
        `pipeline/${args.contentId}/${variant.index}.${ext}`,
      );
      // Sign the upload so the vision-LLM judge can read it. Best-effort —
      // if signing fails we still record the path; the judge just won't
      // score this candidate.
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
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") out.push(r.value);
    else
      out.push({
        index: args.variants[i]!.index,
        prompt: args.variants[i]!.prompt,
        storagePath: null,
        signedUrl: null,
        bytesUrl: null,
      });
  }
  return out;
}

async function judgeStep(args: {
  brief: VisualConceptBrief;
  candidates: GeneratedCandidate[];
  judgeModel?: LlmModel;
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
    model: args.judgeModel,
  });
}

async function uploadAndRecordStep(args: {
  contentId: string;
  kind: AssetKind;
  candidates: GeneratedCandidate[];
  scores: CandidateScore[];
  brief: VisualConceptBrief;
}): Promise<{ winnerStoragePath: string | null }> {
  "use step";
  const winner = pickWinner(args.scores);
  const db = getDb();

  // Insert all generated candidates as drafts. The winner gets promoted
  // (status=approved) so existing approval cards surface it first.
  const rows = args.candidates
    .filter((c) => c.storagePath)
    .map((c) => {
      const score = args.scores.find((s) => s.index === c.index);
      const isWinner = winner?.index === c.index;
      return {
        contentId: args.contentId,
        kind: args.kind,
        storagePath: c.storagePath!,
        promptUsed: c.prompt,
        status: (isWinner ? "approved" : "draft") as
          | "approved"
          | "draft",
        mimeType: "image/png",
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
  const { CpClient } = require("@marketing/cp-client");
  return new CpClient({ baseUrl, internalToken });
}
