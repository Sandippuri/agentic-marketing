import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { ANALYST_PROMPT } from "@marketing/prompts";
import { loadMemoryDir } from "../memory";
import { runGA4Report } from "../ga4-client";

const log = pino({ name: "analyst" });

const MEMORY_ROOT = resolve(import.meta.dirname, "..", "..", "memory");

export type AnalystInput = {
  request: string;
  campaignId?: string;
  cp: CpClient;
};

export async function runAnalyst({ request, campaignId, cp }: AnalystInput): Promise<string> {
  const { text, steps } = await generateText({
    model: anthropic("claude-3-5-sonnet-20241022"),
    system: ANALYST_PROMPT,
    prompt: request,
    maxSteps: 8,
    tools: {
      query_campaign_performance: tool({
        description:
          "Get publish-job channel counts for today and GA4 sessions/conversions for a campaign slug",
        parameters: z.object({
          campaignId: z.string().optional(),
          campaignSlug: z.string().optional().describe("utm_campaign slug for GA4 filtering"),
        }),
        execute: async ({ campaignId: _cid, campaignSlug }) => {
          const channelCounts = await cp.getTodayChannelCounts().catch(() => ({}));

          // Fetch GA4 sessions + conversions filtered by utm_campaign if configured.
          let ga4: Record<string, unknown> = { note: "Set GA4_PROPERTY_ID + GA4_SERVICE_ACCOUNT_JSON to enable" };
          if (process.env.GA4_PROPERTY_ID && process.env.GA4_SERVICE_ACCOUNT_JSON) {
            try {
              const report = await runGA4Report({
                dimensions: ["sessionCampaignName", "sessionDefaultChannelGroup"],
                metrics: ["sessions", "conversions", "totalUsers"],
                campaignFilter: campaignSlug,
                startDate: "30daysAgo",
              });
              ga4 = { rows: report.rows, rowCount: report.rowCount };
            } catch (err) {
              ga4 = { error: (err as Error).message };
            }
          }

          return { channel_counts_today: channelCounts, ga4 };
        },
      }),

      query_stage_performance: tool({
        description: "Get GA4 sessions broken down by landing-page path to infer stage performance",
        parameters: z.object({
          campaignSlug: z.string().optional().describe("utm_campaign slug"),
          startDate: z.string().optional().describe("ISO date or relative e.g. 30daysAgo"),
        }),
        execute: async ({ campaignSlug, startDate }) => {
          if (!process.env.GA4_PROPERTY_ID || !process.env.GA4_SERVICE_ACCOUNT_JSON) {
            return { note: "Set GA4_PROPERTY_ID + GA4_SERVICE_ACCOUNT_JSON to enable stage analytics" };
          }
          try {
            return await runGA4Report({
              dimensions: ["landingPagePlusQueryString", "sessionCampaignName"],
              metrics: ["sessions", "bounceRate", "averageSessionDuration"],
              campaignFilter: campaignSlug,
              startDate: startDate ?? "30daysAgo",
            });
          } catch (err) {
            return { error: (err as Error).message };
          }
        },
      }),

      read_learnings: tool({
        description: "Read all past analyst learnings files",
        parameters: z.object({}),
        execute: async () => loadMemoryDir("learnings"),
      }),

      write_learnings: tool({
        description: "Write a learnings file for the current month",
        parameters: z.object({
          yearMonth: z.string().describe("YYYY-MM format, e.g. 2026-04"),
          content: z.string(),
        }),
        execute: async ({ yearMonth, content }) => {
          const dir = join(MEMORY_ROOT, "learnings");
          await mkdir(dir, { recursive: true });
          const file = join(dir, `${yearMonth}.md`);
          await writeFile(file, content, "utf8");
          log.info({ file }, "wrote learnings");
          return { written: file };
        },
      }),
    },
  });

  log.info({ steps: steps.length }, "analyst finished");
  return text;
}
