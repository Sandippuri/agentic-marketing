/**
 * Pluggable reranker for KB retrieval.
 *
 * Sits AFTER hybrid (vector + BM25) fusion and BEFORE the LLM consumes the
 * top-k. Resolves provider from env so dev environments can default to
 * "none" without breaking production behaviour.
 *
 * Providers:
 *   - "none"   (default)         — passthrough; preserves fused order.
 *   - "cohere" (COHERE_API_KEY)  — Cohere Rerank v3 multilingual.
 *
 * Adding a provider means: add the case below + a single env var. Don't
 * branch on provider at call sites.
 */
import pino from "pino";

const log = pino({ name: "kb-rerank" });

export type RerankProvider = "none" | "cohere";

export type RerankCandidate = {
  /** Stable id used to map back to the original record after reranking. */
  id: string;
  /** Body the reranker will score (typically the chunk text). */
  text: string;
};

export type RerankResult = {
  id: string;
  /** 0..1 relevance from the provider. None-mode returns 1 - rank/total. */
  score: number;
};

export function resolveReranker(): RerankProvider {
  const env = (process.env.KB_RERANKER ?? "").toLowerCase();
  if (env === "cohere" && process.env.COHERE_API_KEY) return "cohere";
  return "none";
}

/**
 * Rerank a list of candidates against a query, returning the top-k by
 * relevance. The input order is preserved as a tiebreaker.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  k: number,
): Promise<RerankResult[]> {
  if (candidates.length === 0) return [];
  const provider = resolveReranker();
  if (provider === "cohere") {
    try {
      return await rerankCohere(query, candidates, k);
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "cohere rerank failed; falling back to passthrough",
      );
      return passthrough(candidates, k);
    }
  }
  return passthrough(candidates, k);
}

function passthrough(
  candidates: RerankCandidate[],
  k: number,
): RerankResult[] {
  const total = candidates.length;
  return candidates.slice(0, k).map((c, i) => ({
    id: c.id,
    score: 1 - i / Math.max(1, total),
  }));
}

async function rerankCohere(
  query: string,
  candidates: RerankCandidate[],
  k: number,
): Promise<RerankResult[]> {
  const apiKey = process.env.COHERE_API_KEY!;
  const model = process.env.COHERE_RERANK_MODEL ?? "rerank-v3.5";
  const topN = Math.min(k, candidates.length);

  const res = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      query,
      documents: candidates.map((c) => c.text.slice(0, 4_000)),
      top_n: topN,
    }),
  });

  if (!res.ok) {
    throw new Error(`cohere rerank → ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    results: Array<{ index: number; relevance_score: number }>;
  };

  return json.results.map((r) => {
    const cand = candidates[r.index];
    if (!cand) throw new Error(`cohere returned out-of-range index ${r.index}`);
    return { id: cand.id, score: r.relevance_score };
  });
}
