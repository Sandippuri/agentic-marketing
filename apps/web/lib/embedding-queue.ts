/**
 * Lightweight wrapper that sends a content ID to the Distributor's
 * embedding BullMQ queue via a Control-Plane-to-Distributor HTTP call.
 *
 * Falls back silently if DISTRIBUTOR_BASE_URL is not set (dev/CI).
 */

const DISTRIBUTOR_BASE_URL = process.env.DISTRIBUTOR_BASE_URL ?? "";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? "";

export async function enqueueEmbedding(contentId: string): Promise<void> {
  if (!DISTRIBUTOR_BASE_URL) return;

  const res = await fetch(`${DISTRIBUTOR_BASE_URL}/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": INTERNAL_API_TOKEN,
    },
    body: JSON.stringify({ contentId }),
  });

  if (!res.ok) {
    throw new Error(`Embedding enqueue failed: ${res.status} ${await res.text()}`);
  }
}
