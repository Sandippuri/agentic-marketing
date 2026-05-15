// Thread history persistence for the chat orchestrator. Backed by Redis when
// REDIS_URL is set; otherwise falls back to an in-process Map (dev / single
// instance only). Phase 3 of the Vercel migration: keeps the chat-handler
// process-agnostic so it works locally without Redis but still scales when a
// Redis URL is provided.

import IORedis from "ioredis";

const HISTORY_KEY_TTL = 60 * 60 * 24 * 7;
const HISTORY_TRIM = 40;

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type HistoryStore = {
  get(threadRef: string): Promise<ChatTurn[]>;
  set(threadRef: string, history: ChatTurn[]): Promise<void>;
};

let cached: HistoryStore | null = null;

export function getHistoryStore(): HistoryStore {
  if (cached) return cached;
  const url = process.env.REDIS_URL;
  cached = url ? buildRedisStore(url) : buildMemoryStore();
  return cached;
}

function buildRedisStore(url: string): HistoryStore {
  const redis = new IORedis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1500,
    lazyConnect: true,
  });
  redis.on("error", () => {});
  return {
    async get(threadRef) {
      try {
        const raw = await redis.get(stateKey(threadRef));
        return raw ? (JSON.parse(raw) as ChatTurn[]) : [];
      } catch {
        return [];
      }
    },
    async set(threadRef, history) {
      const trimmed = history.slice(-HISTORY_TRIM);
      try {
        await redis.set(
          stateKey(threadRef),
          JSON.stringify(trimmed),
          "EX",
          HISTORY_KEY_TTL,
        );
      } catch {
        // best-effort
      }
    },
  };
}

// Single-instance fallback. NOT durable across deploys — fine for local dev,
// risky in serverless because each cold start starts empty. The whole point of
// REDIS_URL being optional is to make local-without-Redis painless; production
// should always set REDIS_URL (or its Upstash equivalent).
const GLOBAL_KEY = "__marketing_chat_history__";
type GlobalShape = typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, ChatTurn[]>;
};
function buildMemoryStore(): HistoryStore {
  const g = globalThis as GlobalShape;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map<string, ChatTurn[]>();
  const store = g[GLOBAL_KEY]!;
  return {
    async get(threadRef) {
      return store.get(threadRef) ?? [];
    },
    async set(threadRef, history) {
      store.set(threadRef, history.slice(-HISTORY_TRIM));
    },
  };
}

function stateKey(threadRef: string): string {
  return `thread:${threadRef}`;
}
