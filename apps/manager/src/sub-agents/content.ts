import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { CONTENT_PROMPT } from "@marketing/prompts";
import { buildBaseMemory, loadMemory } from "../memory";
import { buildSlackApprovalCard, buildDiscordApprovalEmbed } from "../cards/approval";
import { findSimilarContent } from "../find-similar";
import { CHANNELS } from "@marketing/shared-types";

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
};

export async function runContent({
  request,
  campaignId,
  contentId,
  cp,
  threadRef,
  postToThread,
}: ContentInput): Promise<string> {
  const baseMemory = await buildBaseMemory();

  const { text, steps } = await generateText({
    model: anthropic("claude-3-5-sonnet-20241022"),
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
              const approvals = await fetch(
                `${process.env.CP_BASE_URL ?? "http://localhost:3000"}/api/approvals?contentId=${id}`,
                { headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "" } },
              ).then((r) => r.ok ? r.json() as Promise<Array<{ id: string }>> : []).catch(() => []);
              const approvalId = approvals[0]?.id ?? id;

              // Check for an asset.
              const assetRes = await cp.getAsset
                ? await fetch(
                    `${process.env.CP_BASE_URL ?? "http://localhost:3000"}/api/assets?contentId=${id}`,
                    { headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "" } },
                  ).then((r) => r.ok ? r.json() as Promise<Array<{ signedUrl?: string | null }>> : []).catch(() => [])
                : [];
              const assetSignedUrl = (assetRes[0] as { signedUrl?: string | null } | undefined)?.signedUrl ?? null;

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
              };

              // Detect platform from threadRef and post the right card format.
              if (threadRef?.startsWith("slack:")) {
                await postToThread(buildSlackApprovalCard(cardData));
              } else if (threadRef?.startsWith("discord:")) {
                await postToThread(buildDiscordApprovalEmbed(cardData));
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
          // Fetch from /api/approvals?contentId=... — returns the latest decision.
          // The approval with decision='changes_requested' carries the reviewer's note.
          try {
            const res = await fetch(
              `${process.env.CP_BASE_URL ?? "http://localhost:3000"}/api/approvals?contentId=${contentId}`,
              { headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "" } },
            );
            if (!res.ok) return { reason: null, note: "Could not fetch approval" };
            const approvals = (await res.json()) as Array<{ decision: string; reason: string | null }>;
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
  return text;
}
