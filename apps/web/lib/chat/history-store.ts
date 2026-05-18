// Thread history persistence for the chat orchestrator. Backed by Redis when
// REDIS_URL is set; otherwise falls back to an in-process Map (dev / single
// instance only).
//
// Two parallel stores:
//   - getHistoryStore()   → ChatTurn[] (legacy text-only flow, used by
//                            apps/web/app/(admin)/campaigns/[id]/campaign-chat.tsx
//                            via the single-text POST contract).
//   - getUiHistoryStore() → UIMessage[] (new useChat-driven flow on the
//                            Assistant page; preserves tool-invocation parts
//                            so refresh re-renders the full transcript).
//
// They share Redis but use different key prefixes. Eventually the legacy
// store can be retired once campaign-chat migrates to useChat.

import IORedis from "ioredis";
import type { Message } from "ai";

const HISTORY_KEY_TTL = 60 * 60 * 24 * 7;
const HISTORY_TRIM = 40;

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type HistoryStore = {
  get(threadRef: string): Promise<ChatTurn[]>;
  set(threadRef: string, history: ChatTurn[]): Promise<void>;
};

export type UiHistoryStore = {
  get(threadRef: string): Promise<Message[]>;
  set(threadRef: string, messages: Message[]): Promise<void>;
};

let cachedText: HistoryStore | null = null;
let cachedUi: UiHistoryStore | null = null;
let cachedRedis: IORedis | null = null;

function getSharedRedis(): IORedis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (cachedRedis) return cachedRedis;
  cachedRedis = new IORedis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1500,
    lazyConnect: true,
  });
  cachedRedis.on("error", () => {});
  return cachedRedis;
}

export function getHistoryStore(): HistoryStore {
  if (cachedText) return cachedText;
  const redis = getSharedRedis();
  cachedText = redis ? buildRedisText(redis) : buildMemoryText();
  return cachedText;
}

export function getUiHistoryStore(): UiHistoryStore {
  if (cachedUi) return cachedUi;
  const redis = getSharedRedis();
  cachedUi = redis ? buildRedisUi(redis) : buildMemoryUi();
  return cachedUi;
}

function buildRedisText(redis: IORedis): HistoryStore {
  return {
    async get(threadRef) {
      try {
        const raw = await redis.get(textKey(threadRef));
        return raw ? (JSON.parse(raw) as ChatTurn[]) : [];
      } catch {
        return [];
      }
    },
    async set(threadRef, history) {
      const trimmed = history.slice(-HISTORY_TRIM);
      try {
        await redis.set(
          textKey(threadRef),
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

function buildRedisUi(redis: IORedis): UiHistoryStore {
  return {
    async get(threadRef) {
      try {
        const raw = await redis.get(uiKey(threadRef));
        return raw ? (JSON.parse(raw) as Message[]) : [];
      } catch {
        return [];
      }
    },
    async set(threadRef, messages) {
      const trimmed = messages.slice(-HISTORY_TRIM);
      try {
        await redis.set(
          uiKey(threadRef),
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
// risky in serverless because each cold start starts empty. Production should
// always set REDIS_URL.
const TEXT_KEY = "__marketing_chat_history__";
const UI_KEY = "__marketing_chat_ui_history__";
type GlobalShape = typeof globalThis & {
  [TEXT_KEY]?: Map<string, ChatTurn[]>;
  [UI_KEY]?: Map<string, Message[]>;
};

function buildMemoryText(): HistoryStore {
  const g = globalThis as GlobalShape;
  if (!g[TEXT_KEY]) g[TEXT_KEY] = new Map<string, ChatTurn[]>();
  const store = g[TEXT_KEY]!;
  return {
    async get(threadRef) {
      return store.get(threadRef) ?? [];
    },
    async set(threadRef, history) {
      store.set(threadRef, history.slice(-HISTORY_TRIM));
    },
  };
}

function buildMemoryUi(): UiHistoryStore {
  const g = globalThis as GlobalShape;
  if (!g[UI_KEY]) g[UI_KEY] = new Map<string, Message[]>();
  const store = g[UI_KEY]!;
  return {
    async get(threadRef) {
      return store.get(threadRef) ?? [];
    },
    async set(threadRef, messages) {
      store.set(threadRef, messages.slice(-HISTORY_TRIM));
    },
  };
}

function textKey(threadRef: string): string {
  return `thread:${threadRef}`;
}
function uiKey(threadRef: string): string {
  return `thread-ui:${threadRef}`;
}
