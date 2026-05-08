import { generateText, tool } from "ai";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { CONTENT_PROMPT } from "@marketing/prompts";
import { buildBaseMemory, loadMemory } from "../memory";
import { buildSlackApprovalCard, buildDiscordApprovalEmbed, buildWebApprovalCard } from "../cards/approval";
import { findSimilarContent } from "../find-similar";
import { findBrandGuidance } from "../brand-guidance";
import { findCommonMistakes } from "../find-common-mistakes";
import { CHANNELS, type LlmModel } from "@marketing/shared-types";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";

const log = pino({ name: "content" });

export type ContentInput = {
  request: string;
  campaignId: string;
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
  contentId,
  cp,
  threadRef,
  postToThread,
  model,
  jobId,
  workflowRunId,
}: ContentInput): Promise<string> {
  const baseMemory = await buildBaseMemory();

  const { text, steps, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    system: `${CONTENT_PROMPT}\n\n---\n\n# Memory\n\n${baseMemory}`,
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
          const results = await findBrandGuidance({ topic, limit });
          log.info({ topic, count: results.length }, "brand guidance retrieved");
          return results;
        },
      }),

      create_content: tool({
        description: "Create a new draft content item in the Control Plane",
        parameters: z.object({
          title: z.string(),
          bodyMd: z.string(),
          type: z.enum(["blog", "linkedin", "x_thread", "x_post", "email"]),
          stage: z.enum(["pull", "explain", "reinforce", "push"]).optional(),
        }),
        execute: async (input) => {
          const item = await cp.createContent({ campaignId, ...input });
          log.info({ contentId: item.id }, "created content item");
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
                { headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "" } },
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
    model,
    threadRef: threadRef ?? null,
    jobId,
    workflowRunId,
    usage,
    providerMetadata: experimental_providerMetadata,
  });
  return text;
}
