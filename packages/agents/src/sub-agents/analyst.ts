import { generateText, tool } from "ai";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { ANALYST_PROMPT } from "@marketing/prompts";
import { getPrompt } from "../prompt-store";
import { loadMemoryDir } from "../memory";
import { runGA4Report } from "../ga4-client";
import type { LlmModel } from "@marketing/shared-types";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";

const log = pino({ name: "analyst" });

const MEMORY_ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..", "..", "memory") : "";

export type AnalystInput = {
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

export async function runAnalyst({ request, workspaceId, campaignId, cp, model, threadRef, jobId, workflowRunId }: AnalystInput): Promise<string> {
  const systemPrompt = await getPrompt("analyst.system", ANALYST_PROMPT);
  const { text, steps, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    abortSignal: AbortSignal.timeout(180_000),
    maxRetries: 2,
    system: systemPrompt,
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

      query_top_performers: tool({
        description:
          "Retrieve top-performing content items from the outcomes table. " +
          "Use to identify what worked before writing a learnings summary.",
        parameters: z.object({
          channel: z.enum(["internal_blog", "linkedin", "x", "email_hubspot", "email_mailchimp"]).optional(),
          window: z.enum(["7d", "30d", "90d"]).optional().default("30d"),
          sortBy: z.enum(["ctr", "engagement", "impressions", "clicks"]).optional().default("ctr"),
          limit: z.number().int().min(1).max(20).optional().default(10),
        }),
        execute: async ({ channel, window, sortBy, limit }) => {
          const cpBase = process.env.CP_BASE_URL ?? "http://localhost:3000";
          const token = process.env.INTERNAL_API_TOKEN ?? "";
          const qs = new URLSearchParams({
            window: window ?? "30d",
            sortBy: sortBy ?? "ctr",
            limit: String(limit ?? 10),
            ...(channel ? { channel } : {}),
          });
          const res = await fetch(`${cpBase}/api/insights/top-performers?${qs}`, {
            headers: { "x-internal-token": token },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return { error: `top-performers API returned ${res.status}` };
          return res.json();
        },
      }),

      query_metrics: tool({
        description: "Fetch raw metrics rows for a specific content item or campaign from the metrics table.",
        parameters: z.object({
          scopeType: z.enum(["content", "campaign"]),
          scopeId: z.string().uuid(),
          channel: z.enum(["internal_blog", "linkedin", "x", "email_hubspot", "email_mailchimp"]).optional(),
        }),
        execute: async (opts) => {
          return cp.getMetrics(opts).catch((err) => ({ error: (err as Error).message }));
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
  await recordLlmUsage({
    agent: "analyst",
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
