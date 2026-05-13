// Persistence for the daily Researcher report.
// Redis-backed (IORedis) when REDIS_URL is set; in-process Map fallback for
// local dev. Mirrors the pattern in lib/chat/history-store.ts.

import IORedis from "ioredis";

const LATEST_KEY = "research:report:latest";
const DATED_PREFIX = "research:report:";
const DATED_TTL_SECONDS = 60 * 60 * 24 * 90;

export type ResearchKeywordResult = {
  keyword: string;
  status: "ok" | "skipped" | "error";
  report?: string;
  error?: string;
};

export type ResearchReport = {
  date: string;
  generatedAt: string;
  provider: string;
  keywords: string[];
  results: ResearchKeywordResult[];
  combinedMarkdown: string;
};

export type ResearchStore = {
  saveReport(report: ResearchReport): Promise<void>;
  getLatest(): Promise<ResearchReport | null>;
  getByDate(date: string): Promise<ResearchReport | null>;
};

let cached: ResearchStore | null = null;

export function getResearchStore(): ResearchStore {
  if (cached) return cached;
  const url = process.env.REDIS_URL;
  cached = url ? buildRedisStore(url) : buildMemoryStore();
  return cached;
}

function buildRedisStore(url: string): ResearchStore {
  const redis = new IORedis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  return {
    async saveReport(report) {
      const payload = JSON.stringify(report);
      await redis.set(LATEST_KEY, payload);
      await redis.set(
        `${DATED_PREFIX}${report.date}`,
        payload,
        "EX",
        DATED_TTL_SECONDS,
      );
    },
    async getLatest() {
      try {
        const raw = await redis.get(LATEST_KEY);
        return raw ? (JSON.parse(raw) as ResearchReport) : null;
      } catch {
        return null;
      }
    },
    async getByDate(date) {
      try {
        const raw = await redis.get(`${DATED_PREFIX}${date}`);
        return raw ? (JSON.parse(raw) as ResearchReport) : null;
      } catch {
        return null;
      }
    },
  };
}

// Single-process fallback. Same caveats as the chat history-store fallback:
// fine for `pnpm dev`, not durable across deploys, not safe for serverless
// without REDIS_URL.
const GLOBAL_KEY = "__marketing_research_store__";
type GlobalShape = typeof globalThis & {
  [GLOBAL_KEY]?: {
    latest: ResearchReport | null;
    byDate: Map<string, ResearchReport>;
  };
};

function buildMemoryStore(): ResearchStore {
  const g = globalThis as GlobalShape;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { latest: null, byDate: new Map() };
  }
  const store = g[GLOBAL_KEY]!;
  return {
    async saveReport(report) {
      store.latest = report;
      store.byDate.set(report.date, report);
    },
    async getLatest() {
      return store.latest;
    },
    async getByDate(date) {
      return store.byDate.get(date) ?? null;
    },
  };
}
