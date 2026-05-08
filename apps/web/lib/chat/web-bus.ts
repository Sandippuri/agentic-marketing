// In-process pub/sub for web chat threads. Replaces the IORedis pub/sub the
// manager used. See VERCEL-MIGRATION-PLAN §7.1: Phase 3 commits to single-
// region. To go multi-region later, swap this module for an Upstash-backed
// implementation while keeping the same publish/subscribe surface.

import { EventEmitter } from "node:events";

export type WebThreadEvent =
  | { kind: "message"; text: string }
  | { kind: "approval_card"; card: unknown };

// Stash on globalThis so HMR doesn't multiply emitters in dev.
const GLOBAL_KEY = "__marketing_web_bus__";
type GlobalShape = typeof globalThis & { [GLOBAL_KEY]?: EventEmitter };

function getEmitter(): EventEmitter {
  const g = globalThis as GlobalShape;
  if (!g[GLOBAL_KEY]) {
    const emitter = new EventEmitter();
    // Several SSE subscribers + occasional publishers — bump the limit.
    emitter.setMaxListeners(0);
    g[GLOBAL_KEY] = emitter;
  }
  return g[GLOBAL_KEY]!;
}

export function publishWebThreadEvent(
  threadRef: string,
  event: WebThreadEvent,
): void {
  if (!threadRef.startsWith("web:")) return;
  getEmitter().emit(threadRef, event);
}

export function subscribeWebThreadEvents(
  threadRef: string,
  handler: (event: WebThreadEvent) => void,
): () => void {
  const emitter = getEmitter();
  emitter.on(threadRef, handler);
  return () => emitter.off(threadRef, handler);
}
