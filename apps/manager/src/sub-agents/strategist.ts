import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { STRATEGIST_PROMPT } from "@marketing/prompts";
import { buildBaseMemory, loadMemory, loadMemoryDir } from "../memory";
import { findSimilarContent } from "../find-similar";
import { CHANNELS } from "@marketing/shared-types";

const log = pino({ name: "strategist" });

export type StrategistInput = {
  request: string;
  campaignId?: string;
  cp: CpClient;
};

export async function runStrategist({ request, campaignId, cp }: StrategistInput): Promise<string> {
  const baseMemory = await buildBaseMemory();

  const { text, steps } = await generateText({
    model: anthropic("claude-3-5-sonnet-20241022"),
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
  return text;
}
