/**
 * Daily research workflow.
 *
 * For each keyword configured under Settings → Research:
 *   1. Run the Researcher sub-agent in "daily-news" mode using the chosen
 *      search provider (Tavily or Brave).
 *   2. The Researcher writes its per-keyword finding into the KB
 *      (collection 'daily-news', kind 'external_doc') as a side effect.
 *   3. We collect each run's Markdown report, stitch a combined report,
 *      and persist it to the research-store (Redis-backed) so the admin
 *      /research page can render it.
 *
 * Wired to /api/cron/research for daily 02:00 UTC runs (07:45 KTM).
 */
import { inArray } from "drizzle-orm";
import { runResearcher } from "@marketing/agents/sub-agents/researcher";
import { CpClient } from "@marketing/cp-client";
import { getDb, schema } from "@marketing/db";
import {
  resolveResearchSearchProvider,
  type ResearchSearchProvider,
} from "@marketing/shared-types";
import { resolveSubAgentModel } from "@/lib/workflow-engines";
import {
  getResearchStore,
  type ResearchKeywordResult,
  type ResearchReport,
} from "@/lib/research-store";

export type ResearchWorkflowInput = {
  /** Workspace scope; mandatory from PR 4. Threaded via dispatchStart. */
  workspaceId: string;
  /** Optional override — when omitted, loaded from settings.research_keywords. */
  keywords?: string[];
  /** Optional override — when omitted, loaded from settings.research_search_provider. */
  provider?: ResearchSearchProvider;
  /**
   * When set, every kb_write_finding is scoped to this campaign instead of
   * landing in the global daily-news collection. Use for per-campaign research
   * triggered from the campaign admin UI.
   */
  campaignId?: string;
  workflowRunId?: string;
};

export type ResearchWorkflowOutput = {
  date: string;
  provider: ResearchSearchProvider;
  keywordCount: number;
  successCount: number;
  errorCount: number;
};

export async function researchWorkflow(
  input: ResearchWorkflowInput,
): Promise<ResearchWorkflowOutput> {
  "use workflow";

  const config = await loadConfigStep(input);
  if (config.keywords.length === 0) {
    return {
      date: today(),
      provider: config.provider,
      keywordCount: 0,
      successCount: 0,
      errorCount: 0,
    };
  }

  const results: ResearchKeywordResult[] = [];
  for (const keyword of config.keywords) {
    const result = await researchKeywordStep({
      workspaceId: input.workspaceId,
      keyword,
      provider: config.provider,
      campaignId: input.campaignId,
      workflowRunId: input.workflowRunId,
    });
    results.push(result);
  }

  await persistReportStep({
    provider: config.provider,
    keywords: config.keywords,
    results,
  });

  const successCount = results.filter((r) => r.status === "ok").length;
  return {
    date: today(),
    provider: config.provider,
    keywordCount: config.keywords.length,
    successCount,
    errorCount: results.length - successCount,
  };
}

// ============================================================
// Steps
// ============================================================

async function loadConfigStep(input: ResearchWorkflowInput): Promise<{
  keywords: string[];
  provider: ResearchSearchProvider;
}> {
  "use step";
  if (input.keywords && input.provider) {
    return { keywords: dedupe(input.keywords), provider: input.provider };
  }
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(
      inArray(schema.settings.key, [
        "research_keywords",
        "research_search_provider",
      ]),
    );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const keywords =
    input.keywords ??
    (Array.isArray(map.research_keywords)
      ? (map.research_keywords as unknown[]).filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0,
        )
      : []);
  const provider =
    input.provider ?? resolveResearchSearchProvider(map.research_search_provider);
  return { keywords: dedupe(keywords), provider };
}

async function researchKeywordStep(args: {
  workspaceId: string;
  keyword: string;
  provider: ResearchSearchProvider;
  campaignId?: string;
  workflowRunId?: string;
}): Promise<ResearchKeywordResult> {
  "use step";
  const { workspaceId, keyword, provider, campaignId, workflowRunId } = args;
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  const cp = new CpClient({ baseUrl, internalToken });

  const today = new Date().toISOString().slice(0, 10);
  const request = [
    `Daily news scan for: ${keyword}`,
    `Today's date: ${today}.`,
    `Use web_search with freshness='day' (fall back to 'week' if no fresh results).`,
    `Summarise the 3-6 most relevant, distinct, primary-source items from the last 24-48 hours.`,
    `For each item include: title, source URL, one-line takeaway, date.`,
    `Then write ONE kb_write_finding into collectionSlug='daily-news', collectionKind='external_doc', slug='${slugify(keyword)}-${today}'.`,
    `If nothing new and credible surfaced, say so explicitly and skip the kb_write_finding call.`,
  ].join(" ");

  try {
    const report = await runResearcher({
      request,
      workspaceId,
      cp,
      campaignId,
      model: await resolveSubAgentModel("researcher"),
      searchProvider: provider,
      workflowRunId: workflowRunId ?? null,
    });
    return { keyword, status: "ok", report };
  } catch (err) {
    return {
      keyword,
      status: "error",
      error: (err as Error).message,
    };
  }
}

async function persistReportStep(args: {
  provider: ResearchSearchProvider;
  keywords: string[];
  results: ResearchKeywordResult[];
}): Promise<void> {
  "use step";
  const date = today();
  const report: ResearchReport = {
    date,
    generatedAt: new Date().toISOString(),
    provider: args.provider,
    keywords: args.keywords,
    results: args.results,
    combinedMarkdown: buildCombinedMarkdown({
      date,
      provider: args.provider,
      results: args.results,
    }),
  };
  await getResearchStore().saveReport(report);
}

// ============================================================
// Helpers (pure)
// ============================================================

function buildCombinedMarkdown(args: {
  date: string;
  provider: ResearchSearchProvider;
  results: ResearchKeywordResult[];
}): string {
  const lines: string[] = [];
  lines.push(`# Daily research report — ${args.date}`);
  lines.push("");
  lines.push(`_Provider: ${args.provider}. Generated by the daily Researcher cron._`);
  lines.push("");

  if (args.results.length === 0) {
    lines.push("_No keywords configured. Add some in Settings → Research._");
    return lines.join("\n");
  }

  for (const r of args.results) {
    lines.push(`## ${r.keyword}`);
    lines.push("");
    if (r.status === "error") {
      lines.push(`> Research failed: ${r.error ?? "(unknown error)"}`);
    } else {
      lines.push((r.report ?? "").trim() || "_(no findings)_");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
