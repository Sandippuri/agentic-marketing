// Pre-RAG: run kb_search on the user's message BEFORE the orchestrator sees
// it, so relevant playbooks, past content, competitor research, persona docs,
// and chat insights are always in context — without relying on the model to
// remember to call kb_search.
//
// Output is meant to be injected as a SEPARATE (non-cached) system message
// between the cached orchestrator system prompt and the user message, so the
// big stable system block keeps its prompt-cache hit and only the per-turn
// hits incur fresh-token cost.

import pino from "pino";
import { kbSearch, renderHitsForPrompt } from "@marketing/agents/kb";

const log = pino({ name: "knowledge-context" });

// Messages this short almost never warrant a vector search. Skips the
// embedding round-trip on greetings, acks, and one-word replies.
const TRIVIAL_LENGTH_THRESHOLD = 12;

// Single-word confirmations that the orchestrator already handles via the
// "Recent conversation" recap. No point burning a search query on them.
const TRIVIAL_MESSAGES = new Set(
  [
    "hi",
    "hello",
    "hey",
    "yo",
    "thanks",
    "thank you",
    "ty",
    "ok",
    "okay",
    "k",
    "yes",
    "yep",
    "y",
    "no",
    "nope",
    "n",
    "go",
    "go ahead",
    "do it",
    "sure",
    "sounds good",
    "great",
    "cool",
    "nice",
    "perfect",
  ].map((s) => s.toLowerCase()),
);

function isTrivialQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < TRIVIAL_LENGTH_THRESHOLD) return true;
  return TRIVIAL_MESSAGES.has(trimmed.toLowerCase());
}

export type BuildKnowledgeContextOptions = {
  workspaceId: string;
  query: string;
  k?: number;
};

/**
 * Build a "# Relevant Knowledge" block for the chat orchestrator. Returns
 * an empty string when the query is trivial, when the KB has no matches, or
 * when the search throws — chat must never break because the KB is degraded.
 */
export async function buildKnowledgeContext(
  opts: BuildKnowledgeContextOptions,
): Promise<string> {
  if (isTrivialQuery(opts.query)) return "";

  try {
    const hits = await kbSearch({
      workspaceId: opts.workspaceId,
      query: opts.query,
      k: opts.k ?? 4,
      expandToSection: true,
    });
    if (hits.length === 0) return "";
    const rendered = renderHitsForPrompt(hits);
    return [
      "# Relevant Knowledge",
      "",
      "Top hits from this workspace's knowledge base for the current message " +
        "(past content, playbooks, persona/competitor docs, chat insights). " +
        "Treat these as ground truth for facts about us; cite by collection " +
        "and document title when you use them.",
      "",
      rendered,
    ].join("\n");
  } catch (err) {
    log.warn(
      { err: (err as Error).message, workspaceId: opts.workspaceId },
      "kb pre-search failed; continuing without knowledge context",
    );
    return "";
  }
}
