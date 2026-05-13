/**
 * asset-pipeline workflow — the sole image-generation path. Reads the post
 * body + KB, emits a grounded concept brief, judges candidates, writes one
 * winner + runners-up.
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
import {
  uploadAssetBytes,
  uploadGeneratedMedia,
} from "@marketing/agents/asset-uploader";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { buildBrandPromptPrefix } from "@marketing/agents/brand-prompt";
import { CpClient } from "@marketing/cp-client";
import { getDesignSystem } from "@marketing/agents/design-system-store";
import {
  pickTemplate,
  type AssetTemplate,
} from "@marketing/agents/asset-templates";
import {
  resolveBrandTokens,
  type ResolvedTokens,
} from "@marketing/agents/asset-templates/tokens";
import { renderAssetTemplate } from "@/lib/asset-renderer";
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
  // Persist the brief immediately so the fire-and-forget video kickoff (and
  // any other modality) reads from one source. Done as its own step so the
  // write is durable independent of downstream image-gen / judging.
  await persistBriefStep({ contentId: input.contentId, brief });
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
    template: ctx.template,
    tokens: ctx.tokens,
    logos: ctx.logos,
    brief,
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
  template: AssetTemplate;
  tokens: ResolvedTokens;
  logos: Partial<Record<"primary" | "mark" | "wordmark", string>>;
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

  // Brand tokens + logo URLs for the slot renderer. Best-effort — the
  // renderer's resolveColor / logo lookup both fall back gracefully when a
  // value is missing.
  const ds = await getDesignSystem(row.campaignId);
  const tokens = resolveBrandTokens(ds);
  const logos: Partial<Record<"primary" | "mark" | "wordmark", string>> = {};
  for (const l of ds.logos) {
    if (!l.signedUrl) continue;
    if (l.variant === "primary" || l.variant === "mark" || l.variant === "wordmark") {
      logos[l.variant] = l.signedUrl;
    }
  }
  const template = pickTemplate(channel);

  return {
    request: input.request ?? row.title,
    bodyMd: row.bodyMd ?? "",
    channel,
    kind,
    campaignId: row.campaignId,
    brandPrefix,
    imageModel,
    template,
    tokens,
    logos,
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
  template: AssetTemplate;
  tokens: ResolvedTokens;
  logos: Partial<Record<"primary" | "mark" | "wordmark", string>>;
  brief: VisualConceptBrief;
}): Promise<GeneratedCandidate[]> {
  "use step";
  const results = await Promise.allSettled(
    args.variants.map(async (variant) => {
      const opts = variantToImageOpts(variant);
      const result = await generateImage({ ...opts, model: args.imageModel });

      // Materialize raw bytes — generateImage returns either bytes or url.
      let rawBytes: Uint8Array;
      if (result.bytes) {
        rawBytes = result.bytes;
      } else if (result.url) {
        const r = await fetch(result.url);
        if (!r.ok) throw new Error(`download diagram: ${r.status}`);
        rawBytes = new Uint8Array(await r.arrayBuffer());
      } else {
        throw new Error("generateImage returned neither bytes nor url");
      }

      // Stash the raw diagram (model output, no chrome) for forensics — useful
      // when the judge or human disagrees with the rendered version.
      const ext = (result.mimeType.split("/")[1] ?? "png").toLowerCase();
      await uploadGeneratedMedia(
        { bytes: rawBytes, mimeType: result.mimeType },
        `pipeline/${args.contentId}/raw-${variant.index}.${ext}`,
      );

      // Render through the template: deterministic chrome (eyebrow / headline
      // / subline / logo) painted on top of the model's diagram. Failure here
      // falls back to the raw model output so the candidate isn't lost.
      let storagePath: string;
      try {
        const rendered = await renderAssetTemplate({
          template: args.template,
          brief: args.brief,
          tokens: args.tokens,
          logos: args.logos,
          diagramBytes: rawBytes,
        });
        storagePath = `pipeline/${args.contentId}/${variant.index}.png`;
        await uploadAssetBytes(rendered.bytes, rendered.mimeType, storagePath);
      } catch (err) {
        console.warn(
          `[asset-pipeline] template render failed for variant=${variant.index}; falling back to raw model output:`,
          err instanceof Error ? err.message : err,
        );
        storagePath = `pipeline/${args.contentId}/${variant.index}.${ext}`;
        await uploadGeneratedMedia(
          { bytes: rawBytes, mimeType: result.mimeType },
          storagePath,
        );
      }

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
      // Without this, Promise.allSettled would swallow the failure entirely
      // and the workflow would just write zero asset rows — the approval card
      // then shows "Generate image variants" with no clue what went wrong.
      console.error(
        `[asset-pipeline] candidate ${args.variants[i]!.index} failed:`,
        reason,
      );
      failures.push({ index: args.variants[i]!.index, reason });
      out.push({
        index: args.variants[i]!.index,
        prompt: args.variants[i]!.prompt,
        storagePath: null,
        signedUrl: null,
        bytesUrl: null,
      });
    }
  }
  // Fail loudly when every candidate failed — the workflow will go to
  // "failed" state instead of producing an approval with no images.
  if (out.every((c) => !c.storagePath)) {
    const summary = failures
      .map((f) => `[${f.index}] ${f.reason.split("\n")[0]}`)
      .join("; ");
    throw new Error(
      `All ${args.variants.length} image candidates failed: ${summary}`,
    );
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
  // (status=approved) so existing approval cards surface it first. Each row
  // carries the Judge's structured score so the learning loop (Phase D) can
  // query high-scoring assets without re-judging.
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
