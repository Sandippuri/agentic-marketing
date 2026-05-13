/**
 * findCommonMistakes — embed a topic and retrieve semantically similar past
 * AI drafts that were rejected or sent back for changes, along with the
 * reviewer's reason.
 *
 * Used by the Content sub-agent before drafting in problem areas, so it can
 * see past misses and not repeat them. Phase 11 — `findCommonMistakes`.
 *
 * Returns an empty array until the agent_feedback corpus is large enough; the
 * sub-agent prompt treats empty results as a no-op signal.
 */

import pino from "pino";
import { embedText, getEmbeddingConfig } from "./kb/embed-client";

const log = pino({ name: "find-common-mistakes" });

export type CommonMistakeResult = {
  feedback_id: string;
  content_id: string;
  ai_draft_md: string;
  decision: "rejected" | "changes_requested" | "approved";
  reason: string | null;
  edit_distance: number | null;
  decided_at: string;
  similarity: number | null;
};

export type FindCommonMistakesOptions = {
  topic: string;
  limit?: number;
};

export async function findCommonMistakes(
  opts: FindCommonMistakesOptions,
): Promise<CommonMistakeResult[]> {
  const cpBase = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const token = process.env.INTERNAL_API_TOKEN ?? "";

  let vector: number[];
  let model: string;
  try {
    vector = await embedText(opts.topic);
    model = (await getEmbeddingConfig()).model;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "embed failed; returning empty");
    return [];
  }

  const res = await fetch(`${cpBase}/api/content/common-mistakes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify({
      vector,
      model,
      limit: opts.limit ?? 5,
    }),
  });

  if (!res.ok) {
    log.warn({ status: res.status }, "common-mistakes API returned error");
    return [];
  }

  return (await res.json()) as CommonMistakeResult[];
}
