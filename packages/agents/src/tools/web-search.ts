/**
 * Web search tool for the Researcher sub-agent.
 *
 * Two backends, toggled by `provider`:
 *   - tavily : POST https://api.tavily.com/search  (TAVILY_API_KEY)
 *   - brave  : GET  https://api.search.brave.com/res/v1/web/search (BRAVE_SEARCH_API_KEY)
 *
 * Both return a normalised `{ results: [{ title, url, snippet, publishedAt? }] }`.
 * Tavily can also return a synthesised answer and longer content per result; we
 * forward that through so the LLM doesn't need to re-fetch unless it wants the
 * full page.
 */
import { tool } from "ai";
import { z } from "zod";
import type { ResearchSearchProvider } from "@marketing/shared-types";

type NormalisedResult = {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  content?: string;
};

type NormalisedSearch = {
  provider: ResearchSearchProvider;
  query: string;
  answer?: string;
  results: NormalisedResult[];
};

export function buildWebSearchTool({
  provider,
}: {
  provider: ResearchSearchProvider;
}) {
  return {
    web_search: tool({
      description:
        "Search the public web for fresh information about a keyword, topic, brand, or news item. Returns ranked results with title, URL, snippet, and (when available) a publish date and a longer content excerpt. Use this BEFORE web_fetch — search first to discover URLs, then web_fetch only when you need the full page.",
      parameters: z.object({
        query: z.string().min(2).max(400),
        maxResults: z.number().int().min(1).max(15).optional().default(8),
        freshness: z
          .enum(["day", "week", "month", "year", "any"])
          .optional()
          .describe(
            "Time window for results. Use 'day' or 'week' for latest news; 'any' for evergreen.",
          ),
      }),
      execute: async ({ query, maxResults, freshness }) => {
        try {
          if (provider === "tavily") {
            return await searchTavily({ query, maxResults, freshness });
          }
          return await searchBrave({ query, maxResults, freshness });
        } catch (err) {
          return {
            provider,
            query,
            results: [],
            error: (err as Error).message,
          };
        }
      },
    }),
  };
}

async function searchTavily({
  query,
  maxResults,
  freshness,
}: {
  query: string;
  maxResults: number;
  freshness?: "day" | "week" | "month" | "year" | "any";
}): Promise<NormalisedSearch> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY not set. Add it to env or switch research_search_provider to 'brave'.",
    );
  }
  const days = tavilyDays(freshness);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "advanced",
      include_answer: true,
      topic: freshness && freshness !== "any" ? "news" : "general",
      ...(days ? { days } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Tavily search ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    answer?: string;
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
    }>;
  };
  return {
    provider: "tavily",
    query,
    answer: data.answer,
    results: (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? r.url ?? "(untitled)",
      url: r.url ?? "",
      snippet: truncate(r.content ?? "", 400),
      content: r.content ? truncate(r.content, 2_000) : undefined,
      publishedAt: r.published_date,
    })),
  };
}

function tavilyDays(
  freshness: "day" | "week" | "month" | "year" | "any" | undefined,
): number | undefined {
  switch (freshness) {
    case "day":
      return 1;
    case "week":
      return 7;
    case "month":
      return 30;
    case "year":
      return 365;
    default:
      return undefined;
  }
}

async function searchBrave({
  query,
  maxResults,
  freshness,
}: {
  query: string;
  maxResults: number;
  freshness?: "day" | "week" | "month" | "year" | "any";
}): Promise<NormalisedSearch> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error(
      "BRAVE_SEARCH_API_KEY not set. Add it to env or switch research_search_provider to 'tavily'.",
    );
  }
  const params = new URLSearchParams({
    q: query,
    count: String(maxResults),
  });
  const braveFreshness = braveFreshnessParam(freshness);
  if (braveFreshness) params.set("freshness", braveFreshness);
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Brave search ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        age?: string;
        page_age?: string;
      }>;
    };
  };
  return {
    provider: "brave",
    query,
    results: (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? r.url ?? "(untitled)",
      url: r.url ?? "",
      snippet: stripHtml(truncate(r.description ?? "", 400)),
      publishedAt: r.page_age ?? r.age,
    })),
  };
}

function braveFreshnessParam(
  freshness: "day" | "week" | "month" | "year" | "any" | undefined,
): string | null {
  switch (freshness) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
