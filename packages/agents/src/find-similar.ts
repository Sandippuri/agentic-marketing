/**
 * findSimilarContent — embed a topic and retrieve semantically similar approved
 * content items from the Control Plane's pgvector index.
 *
 * Used by the Strategist and Content sub-agents to ground new drafts in past
 * wins before generating anything. Phase 11 Day 3.
 */

import pino from "pino";
import { embedText, getEmbeddingConfig } from "./kb/embed-client";

const log = pino({ name: "find-similar" });

export type SimilarContentResult = {
  content_id: string;
  title: string;
  body_md: string;
  published_url: string | null;
  outcomes: {
    channel: string;
    ctr: number;
    engagement_rate: number;
    impressions: number;
    clicks: number;
  } | null;
  similarity: number | null;
};

export type FindSimilarOptions = {
  topic: string;
  channel?: string;
  minCTR?: number;
  minEngagement?: number;
  window?: "7d" | "30d" | "90d";
  limit?: number;
};

export async function findSimilarContent(
  opts: FindSimilarOptions,
): Promise<SimilarContentResult[]> {
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

  const res = await fetch(`${cpBase}/api/content/similar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify({
      vector,
      model,
      channel: opts.channel,
      minCTR: opts.minCTR,
      minEngagement: opts.minEngagement,
      window: opts.window ?? "30d",
      limit: opts.limit ?? 5,
    }),
  });

  if (!res.ok) {
    log.warn({ status: res.status }, "similar content API returned error");
    return [];
  }

  return (await res.json()) as SimilarContentResult[];
}
