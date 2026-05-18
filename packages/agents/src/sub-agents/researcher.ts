/**
 * Researcher sub-agent. Audience / persona / competitor / market research.
 *
 * Reads the Knowledge Base first (kb_search), fetches external pages
 * (web_fetch — best-effort, env-gated), and writes findings back to the KB
 * via kb_write_finding (high-confidence) or kb_propose_update (drafts for
 * human review). Output is Markdown.
 */
import { generateText } from "ai";
import { z } from "zod";
import { tool } from "ai";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import type { LlmModel, ResearchSearchProvider } from "@marketing/shared-types";
import { DEFAULT_RESEARCH_SEARCH_PROVIDER } from "@marketing/shared-types";
import { RESEARCHER_PROMPT } from "@marketing/prompts";
import { getPrompt } from "../prompt-store";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";
import { buildKbTools } from "../tools/kb-tools";
import { buildWebSearchTool } from "../tools/web-search";
import { buildXProfileTool } from "../tools/x-profile";
import { buildKbArchiveImageTool } from "../tools/kb-archive-image";

const log = pino({ name: "researcher" });

export type ResearcherInput = {
  request: string;
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  campaignId?: string;
  cp: CpClient;
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  /**
   * External search backend for `web_search`. Defaults to the project-wide
   * setting; callers that already resolved it can pass the chosen provider.
   */
  searchProvider?: ResearchSearchProvider;
};

export async function runResearcher({
  request,
  workspaceId,
  campaignId,
  model,
  threadRef,
  jobId,
  workflowRunId,
  searchProvider,
}: ResearcherInput): Promise<string> {
  const kbTools = buildKbTools({ workspaceId, campaignId });
  const webSearch = buildWebSearchTool({
    provider: searchProvider ?? DEFAULT_RESEARCH_SEARCH_PROVIDER,
  });
  const xProfile = buildXProfileTool();
  const kbArchiveImage = buildKbArchiveImageTool();

  const systemPrompt = await getPrompt("researcher.system", RESEARCHER_PROMPT);
  const { text, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    system: systemPrompt,
    prompt: request,
    maxSteps: 12,
    tools: {
      ...kbTools,
      ...webSearch,
      ...xProfile,
      ...kbArchiveImage,
      web_fetch: tool({
        description:
          "Fetch a public URL and return its readable text (truncated to ~10k chars). Use sparingly — prefer kb_search for things we already know. Returns {status, contentType, text, url}.",
        parameters: z.object({
          url: z.string().url(),
        }),
        execute: async ({ url }) => {
          try {
            const res = await fetch(url, {
              headers: { "user-agent": "marketing-agent-researcher/0.1" },
            });
            const contentType = res.headers.get("content-type") ?? "";
            const text = (await res.text()).slice(0, 10_000);
            return { status: res.status, contentType, text, url };
          } catch (err) {
            return {
              status: 0,
              error: (err as Error).message,
              url,
            };
          }
        },
      }),
    },
  });

  await recordLlmUsage({
    agent: "researcher",
    workspaceId,
    model,
    threadRef: threadRef ?? undefined,
    jobId: jobId ?? null,
    workflowRunId: workflowRunId ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });

  return text;
}
