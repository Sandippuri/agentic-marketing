import { generateText, tool } from "ai";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { CONTENT_PROMPT } from "@marketing/prompts";
import { getPrompt } from "../prompt-store";
import { buildBaseMemory, buildVisualMemory, loadMemory } from "../memory";
import { buildSlackApprovalCard, buildDiscordApprovalEmbed, buildWebApprovalCard } from "../cards/approval";
import { findSimilarContent } from "../find-similar";
import { findBrandGuidance } from "../brand-guidance";
import { findCommonMistakes } from "../find-common-mistakes";
import {
  CHANNELS,
  maxImagesForContentType,
  type ContentType,
  type LlmModel,
} from "@marketing/shared-types";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";

const log = pino({ name: "content" });

/**
 * Per-post image brief emitted by the Content agent at draft time.
 * The Art Director refines this into the model prompt — it's NOT meant to be
 * the prompt itself. Describe the LITERAL subject (what's in frame, what
 * composition, what to avoid) — never the message ("show growth"). The model
 * can't render abstract concepts; it can render specific things.
 *
 * Stored on `content_items.image_brief` (jsonb) as an ARRAY of briefs since
 * migration 0040 — one entry per intended image slot. A post may carry 1–4
 * briefs (clamped by content-type cap; see maxImagesForContentType).
 */
export type ImageBrief = {
  /** Literal subject in frame: "single laptop on wooden desk, screen showing line chart trending up". */
  subject: string;
  /** Camera framing. */
  composition: "close_up" | "medium" | "wide" | "overhead";
  /** Mood / atmosphere ("calm focused early-morning light"). */
  mood: string;
  /** Optional headline copy the model should render INTO the image. */
  overlay_text?: string;
  /** Concrete elements that MUST appear ("upward trend", "warm window light"). */
  must_show: string[];
  /** Concrete elements that must NOT appear ("human faces", "cluttered desk"). */
  must_not_show: string[];
};

export type ContentInput = {
  request: string;
  campaignId: string;
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  contentId?: string;
  cp: CpClient;
  /** For posting the approval card after submit */
  threadRef?: string;
  /** Callback to post a message to the originating thread */
  postToThread?: (message: string | object) => Promise<void>;
  model?: LlmModel;
  jobId?: string | null;
  workflowRunId?: string | null;
};

export async function runContent({
  request,
  campaignId,
  workspaceId,
  contentId,
  cp,
  threadRef,
  postToThread,
  model,
  jobId,
  workflowRunId,
}: ContentInput): Promise<string> {
  const [baseMemory, visualMemory] = await Promise.all([
    buildBaseMemory({ workspaceId, campaignId }),
    // includeTokens=false: copy doesn't need hex codes or font families, just
    // the mood/style words from brand.visual.
    buildVisualMemory({ workspaceId, campaignId, includeTokens: false }),
  ]);
  const memoryBody = [baseMemory, visualMemory]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
  const systemBody = await getPrompt("content.system", CONTENT_PROMPT);

  const { text, steps, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    abortSignal: AbortSignal.timeout(180_000),
    maxRetries: 2,
    system: `${systemBody}\n\n---\n\n# Memory\n\n${memoryBody}`,
    prompt: request,
    maxSteps: 8,
    tools: {
      read_brief: tool({
        description: "Fetch the campaign brief and calendar from the Control Plane",
        parameters: z.object({ campaignId: z.string() }),
        execute: async ({ campaignId: cid }) => {
          const campaign = await cp.getCampaign(cid);
          return {
            name: campaign.name,
            phase: campaign.phase,
            briefMd: campaign.briefMd ?? "(no brief yet)",
            calendar: campaign.calendarJson,
          };
        },
      }),

      list_content: tool({
        description: "List existing content items for a campaign. Use this to check what drafts already exist before creating a new one, and to find content IDs when revising.",
        parameters: z.object({
          campaignId: z.string(),
          status: z.enum(["draft", "in_review", "approved", "scheduled", "published", "retracted"]).optional(),
          limit: z.number().int().min(1).max(50).optional().default(20),
        }),
        execute: async ({ campaignId: cid, status, limit }) => {
          const result = await cp.listContent({ campaignId: cid, status, limit });
          log.info({ cid, total: result.total }, "listed content");
          return result;
        },
      }),

      read_memory: tool({
        description: "Read a memory file by relative path",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => loadMemory(path),
      }),

      find_similar_content: tool({
        description:
          "Retrieve semantically similar approved content items from the knowledge base. " +
          "Call this BEFORE writing the first draft to ground the post in past wins. " +
          "Cite the results in a <rationale> block at the top of your response.",
        parameters: z.object({
          topic: z.string().describe("Short description of the topic / angle you're drafting"),
          channel: z.enum(CHANNELS).optional().describe("Target channel — helps filter outcomes"),
          minCTR: z.number().min(0).max(1).optional(),
          minEngagement: z.number().min(0).max(1).optional(),
          limit: z.number().int().min(1).max(10).optional().default(5),
        }),
        execute: async (opts) => {
          const results = await findSimilarContent(opts);
          log.info({ topic: opts.topic, count: results.length }, "similar content retrieved");
          return results;
        },
      }),

      find_common_mistakes: tool({
        description:
          "Search past AI drafts that were rejected or sent back for changes by a human reviewer. " +
          "Returns the AI draft text plus the reviewer's reason. " +
          "Call this BEFORE drafting in a problem area so you can avoid repeating the same mistakes. " +
          "May return an empty list if not enough rejections have been recorded yet — that is a normal no-op.",
        parameters: z.object({
          topic: z.string().describe("Short description of the topic / angle you're drafting"),
          limit: z.number().int().min(1).max(10).optional().default(5),
        }),
        execute: async ({ topic, limit }) => {
          const results = await findCommonMistakes({ topic, limit });
          log.info({ topic, count: results.length }, "common mistakes retrieved");
          return results;
        },
      }),

      find_brand_guidance: tool({
        description:
          "Search brand documents (voice, ICP, positioning, channel SOPs) for guidance " +
          "relevant to the topic you're writing about. " +
          "Call this alongside find_similar_content before drafting to ensure tone, " +
          "terminology, and structural conventions match the brand guidelines.",
        parameters: z.object({
          topic: z.string().describe("The topic, angle, or specific question to look up in brand docs"),
          limit: z.number().int().min(1).max(8).optional().default(4),
        }),
        execute: async ({ topic, limit }) => {
          const results = await findBrandGuidance({ topic, workspaceId, limit });
          log.info({ topic, count: results.length }, "brand guidance retrieved");
          return results;
        },
      }),

      create_content: tool({
        description:
          "Create a new draft content item in the Control Plane. " +
          "MUST include imageBriefs — an array of 1–4 briefs, one per intended image. " +
          "The asset pipeline generates one image per brief. " +
          "Use multiple briefs only when each carries distinct information (before/after, multi-step explainer, carousel of stats). " +
          "Channel caps apply: linkedin and email accept 1 image; blog / x_post / x_thread accept up to 4.",
        parameters: z.object({
          title: z.string(),
          bodyMd: z.string(),
          type: z.enum(["blog", "linkedin", "x_thread", "x_post", "email"]),
          stage: z.enum(["pull", "explain", "reinforce", "push"]).optional(),
          imageBriefs: z
            .array(
              z.object({
                subject: z
                  .string()
                  .min(8)
                  .describe(
                    "Literal subject in frame. Specific objects, no abstractions. Example: 'single laptop on a wooden desk, screen showing a line chart with sharp upward inflection at month 6'",
                  ),
                composition: z
                  .enum(["close_up", "medium", "wide", "overhead"])
                  .describe("Camera framing"),
                mood: z
                  .string()
                  .min(4)
                  .describe("Mood / atmosphere ('calm, focused, early-morning light')"),
                overlay_text: z
                  .string()
                  .max(80)
                  .optional()
                  .describe(
                    "Optional ≤8-word headline the image model should render INTO the image. Leave empty for blog OG images where text is added separately.",
                  ),
                must_show: z
                  .array(z.string())
                  .describe("Concrete elements that MUST appear"),
                must_not_show: z
                  .array(z.string())
                  .describe(
                    "Concrete elements that must NOT appear (e.g. 'human faces', 'cluttered desk', 'stock 3D coins')",
                  ),
              }),
            )
            .min(1)
            .max(4)
            .describe(
              "Array of 1–4 image briefs in display order. Slot 0 is the lead/cover. Use multiple briefs only when each adds distinct information.",
            ),
        }),
        execute: async ({ imageBriefs, ...input }) => {
          // Clamp to the content-type cap as a safety net — the LLM is
          // instructed via prompt, but a stray 4-brief emit on a `linkedin`
          // post would otherwise persist and surface as silently-dropped
          // images at publish time. Trim the tail rather than reject so the
          // create still succeeds.
          const cap = maxImagesForContentType(input.type as ContentType);
          const clamped = imageBriefs.slice(0, cap);
          const item = await cp.createContent({
            campaignId,
            ...input,
            imageBriefs: clamped,
          });
          log.info(
            {
              contentId: item.id,
              imageBriefCount: clamped.length,
              clampedFrom: imageBriefs.length,
            },
            "created content item",
          );
          return item;
        },
      }),

      revise_content: tool({
        description: "Update the body of an existing content item (used after changes_requested)",
        parameters: z.object({
          id: z.string(),
          bodyMd: z.string(),
          title: z.string().optional(),
        }),
        execute: async ({ id, ...fields }) => {
          const item = await cp.patchContent(id, fields);
          log.info({ id }, "revised content item");
          return item;
        },
      }),

      submit_for_review: tool({
        description: "Transition a content item from draft to in_review for human approval. Also posts an approval card to the originating chat thread.",
        parameters: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          const item = await cp.submitContent(id);
          log.info({ id }, "submitted content for review");

          // Look up the campaign and approval so we can build a rich approval card.
          if (postToThread) {
            try {
              const campaign = await cp.getCampaign(item.campaignId).catch(() => null);
              const approvals = await cp.getApprovalsForContent(id).catch(() => []);
              const approvalId = approvals[0]?.id ?? id;

              type AssetRow = {
                kind?: string | null;
                mimeType?: string | null;
                durationSec?: number | null;
                signedUrl?: string | null;
              };
              const assetRes = await fetch(
                `${process.env.CP_BASE_URL ?? "http://localhost:3000"}/api/assets?contentId=${id}`,
                {
                  headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "" },
                  signal: AbortSignal.timeout(10_000),
                },
              )
                .then((r) =>
                  r.ok ? (r.json() as Promise<AssetRow[]>) : Promise.resolve([]),
                )
                .catch(() => [] as AssetRow[]);

              // Split image vs video so the card can show both. The first still
              // image lands as the inline thumbnail; video gets its own block.
              const firstImage = assetRes.find(
                (a) => a.kind !== "video_post" && a.signedUrl,
              );
              const firstVideo = assetRes.find(
                (a) => a.kind === "video_post" && a.signedUrl,
              );
              const assetSignedUrl = firstImage?.signedUrl ?? null;
              const videoSignedUrl = firstVideo?.signedUrl ?? null;
              const videoMimeType = firstVideo?.mimeType ?? null;
              const videoDurationSec = firstVideo?.durationSec ?? null;

              const cardData = {
                approvalId,
                contentId: id,
                title: item.title,
                type: item.type,
                stage: item.stage,
                bodyPreview: item.bodyMd.slice(0, 300),
                campaignName: campaign?.name ?? item.campaignId,
                requestedAt: new Date().toISOString(),
                assetSignedUrl,
                videoSignedUrl,
                videoMimeType,
                videoDurationSec,
              };

              // Detect platform from threadRef and post the right card format.
              if (threadRef?.startsWith("slack:")) {
                await postToThread(buildSlackApprovalCard(cardData));
              } else if (threadRef?.startsWith("discord:")) {
                await postToThread(buildDiscordApprovalEmbed(cardData));
              } else if (threadRef?.startsWith("web:")) {
                await postToThread(buildWebApprovalCard(cardData));
              } else {
                // Fallback: plain text summary.
                await postToThread(
                  `📋 *Review requested:* "${item.title}" is in_review.\n` +
                  `Approve: \`/approve ${approvalId}\`\n` +
                  `Request changes: \`/changes ${approvalId} <reason>\``,
                );
              }
              log.info({ id, approvalId }, "approval card posted to thread");
            } catch (err) {
              log.warn({ err: (err as Error).message }, "failed to post approval card");
            }
          }

          return item;
        },
      }),

      get_revision_reason: tool({
        description: "Fetch the reason from the latest changes_requested approval decision for a content item. Call this at the start of a revision so you know exactly what the reviewer wants changed.",
        parameters: z.object({ contentId: z.string() }),
        execute: async ({ contentId }) => {
          try {
            const approvals = await cp.getApprovalsForContent(contentId);
            const latest = approvals.find((a) => a.decision === "changes_requested");
            return { reason: latest?.reason ?? null };
          } catch {
            return { reason: null };
          }
        },
      }),
    },
  });

  log.info({ steps: steps.length, campaignId }, "content sub-agent finished");
  await recordLlmUsage({
    agent: "content",
    workspaceId,
    model,
    threadRef: threadRef ?? null,
    jobId,
    workflowRunId,
    usage,
    providerMetadata: experimental_providerMetadata,
  });
  return text;
}
