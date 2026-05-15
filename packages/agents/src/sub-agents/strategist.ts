import { generateText, tool } from "ai";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { STRATEGIST_PROMPT } from "@marketing/prompts";
import { buildBaseMemory, loadMemory, loadMemoryDir } from "../memory";
import { findSimilarContent } from "../find-similar";
import { findBrandGuidance } from "../brand-guidance";
import { CHANNELS, type LlmModel } from "@marketing/shared-types";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";

const log = pino({ name: "strategist" });

/**
 * Campaign-level visual identity. Set once per campaign by the Strategist;
 * reused by the Art Director when refining every per-post image brief into a
 * model prompt. Stored on `campaigns.visual_identity` (jsonb).
 *
 * The point: keep image direction CONSISTENT across all posts in a campaign
 * (recurring motifs, color/mood, art style) instead of letting each post
 * drift into a different look. Banned aesthetics are the failure modes the
 * Strategist wants the model to never produce for this brand.
 */
export type VisualIdentity = {
  /** Recurring motifs the brand wants in every campaign image. */
  recurring_motifs: string[];
  /** Lighting/mood/temperature in plain language. */
  color_mood: string;
  /** Art style label ("editorial illustration", "documentary photo"). */
  art_style: string;
  /** Failure modes the model must NOT produce. */
  banned_aesthetics: string[];
};

export type StrategistInput = {
  request: string;
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  campaignId?: string;
  cp: CpClient;
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

export async function runStrategist({ request, workspaceId, campaignId, cp, model, threadRef, jobId, workflowRunId }: StrategistInput): Promise<string> {
  const baseMemory = await buildBaseMemory();

  const { text, steps, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    system: `${STRATEGIST_PROMPT}\n\n---\n\n# Memory\n\n${baseMemory}`,
    prompt: request,
    maxSteps: 8,
    tools: {
      read_memory: tool({
        description: "Read a memory file by relative path (e.g. brand/voice.md, learnings/2026-04.md)",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => {
          return loadMemory(path);
        },
      }),

      read_past_learnings: tool({
        description: "Read all analyst learnings files from the learnings/ directory",
        parameters: z.object({ since: z.string().optional().describe("ISO date string — not used for filtering yet, included for future") }),
        execute: async () => {
          return loadMemoryDir("learnings");
        },
      }),

      list_content: tool({
        description: "List existing content items for a campaign by status. Use to see what's already in flight before scheduling new items.",
        parameters: z.object({
          campaignId: z.string(),
          status: z.enum(["draft", "in_review", "approved", "scheduled", "published", "retracted"]).optional(),
          limit: z.number().int().min(1).max(50).optional().default(20),
        }),
        execute: async ({ campaignId: cid, status, limit }) => {
          const result = await cp.listContent({ campaignId: cid, status, limit });
          return result;
        },
      }),

      find_brand_guidance: tool({
        description:
          "Search brand Markdown files (voice, ICP, positioning) for guidance relevant to " +
          "the campaign or brief you're writing. Use before writing a campaign brief to ensure " +
          "the messaging matches the brand's established voice and target audience.",
        parameters: z.object({
          topic: z.string().describe("The campaign topic, product area, or question to look up"),
          limit: z.number().int().min(1).max(6).optional().default(4),
        }),
        execute: async ({ topic, limit }) => {
          return findBrandGuidance({ topic, workspaceId, limit });
        },
      }),

      create_campaign: tool({
        description: "Create a new campaign in the Control Plane",
        parameters: z.object({
          slug: z.string(),
          name: z.string(),
          phase: z.enum(["buildup", "launch", "post_launch"]).optional(),
          briefMd: z.string().optional(),
        }),
        execute: async (input) => {
          const campaign = await cp.createCampaign(input);
          log.info({ campaignId: campaign.id }, "created campaign");
          return campaign;
        },
      }),

      update_campaign: tool({
        description: "Update an existing campaign's brief or phase",
        parameters: z.object({
          id: z.string(),
          briefMd: z.string().optional(),
          phase: z.enum(["buildup", "launch", "post_launch"]).optional(),
        }),
        execute: async ({ id, ...fields }) => {
          const result = await cp.patchCampaign(id, fields);
          log.info({ id }, "updated campaign");
          return result;
        },
      }),

      set_visual_identity: tool({
        description:
          "Set the campaign's visual identity — recurring motifs, color/mood, art style, " +
          "and banned aesthetics. Call this ONCE per campaign, after the brief is written " +
          "and before scheduling content. Every post's image will be art-directed against " +
          "this identity to keep the campaign visually consistent. " +
          "Be specific and concrete: 'isometric dashboard screenshots' beats 'modern UI'. " +
          "Banned aesthetics should name the AI-slop failure modes you want avoided " +
          "('no AI faces', 'no generic crypto coins', 'no rainbow gradients').",
        parameters: z.object({
          campaignId: z.string(),
          recurring_motifs: z
            .array(z.string())
            .min(1)
            .describe(
              "Motifs that should appear across all campaign images (e.g. 'editorial line illustration of a single product flow', 'warm desk-top photography with one device')",
            ),
          color_mood: z
            .string()
            .min(4)
            .describe("Lighting + mood + palette in plain language"),
          art_style: z
            .string()
            .min(4)
            .describe(
              "One concrete style label ('editorial illustration, not stock photo', 'documentary photo, natural light')",
            ),
          banned_aesthetics: z
            .array(z.string())
            .describe("Failure modes the model must NOT produce"),
        }),
        execute: async ({ campaignId: cid, ...identity }) => {
          await cp.patchCampaign(cid, { visualIdentity: identity });
          log.info({ cid }, "visual identity set");
          return { campaignId: cid, saved: true, identity };
        },
      }),

      find_similar_content: tool({
        description:
          "Retrieve semantically similar approved content items from the knowledge base. " +
          "Call this BEFORE drafting any new content to ground the response in past wins. " +
          "Cite the results in a <rationale> block in your response.",
        parameters: z.object({
          topic: z.string().describe("Short description of the topic / angle you're exploring"),
          channel: z.enum(CHANNELS).optional().describe("Filter by a specific channel"),
          minCTR: z.number().min(0).max(1).optional().describe("Minimum click-through rate (0–1)"),
          minEngagement: z.number().min(0).max(1).optional().describe("Minimum engagement rate (0–1)"),
          limit: z.number().int().min(1).max(10).optional().default(5),
        }),
        execute: async (opts) => {
          const results = await findSimilarContent(opts);
          log.info({ topic: opts.topic, count: results.length }, "similar content retrieved");
          return results;
        },
      }),

      write_calendar: tool({
        description: "Persist a content calendar to a campaign's calendarJson field",
        parameters: z.object({
          campaignId: z.string(),
          items: z.array(
            z.object({
              title: z.string(),
              type: z.enum(["blog", "linkedin", "x_thread", "x_post", "email"]),
              stage: z.enum(["pull", "explain", "reinforce", "push"]),
              phase: z.enum(["buildup", "launch", "post_launch"]),
              scheduledFor: z.string().optional().describe("ISO date string"),
            }),
          ),
        }),
        execute: async ({ campaignId: cid, items }) => {
          log.info({ cid, count: items.length }, "writing calendar");
          await cp.patchCampaign(cid, { calendarJson: items });
          return { campaignId: cid, itemCount: items.length, saved: true };
        },
      }),
    },
  });

  log.info({ steps: steps.length }, "strategist finished");
  await recordLlmUsage({
    agent: "strategist",
    workspaceId,
    model,
    threadRef,
    jobId,
    workflowRunId,
    usage,
    providerMetadata: experimental_providerMetadata,
  });
  return text;
}
