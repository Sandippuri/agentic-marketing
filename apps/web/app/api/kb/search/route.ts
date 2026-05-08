/**
 * POST /api/kb/search — semantic search over the Knowledge Base.
 *
 * Wraps kbSearch from @marketing/agents/kb. Same surface used by sub-agents
 * via the kb_search tool; this HTTP entry point is for the admin UI and
 * for any out-of-process consumers (e.g. workers in apps/distributor
 * during the Phase 4 cutover).
 */
import { z } from "zod";
import { kbSearch, type CollectionKind } from "@marketing/agents/kb";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const KIND = z.enum([
  "brand",
  "product",
  "persona",
  "competitor",
  "sop",
  "playbook",
  "past_content",
  "asset_caption",
  "visual_reference",
  "external_doc",
]);

const SearchRequest = z.object({
  query: z.string().min(1),
  collectionKinds: z.array(KIND).optional(),
  collectionIds: z.array(z.string().uuid()).optional(),
  campaignId: z.string().uuid().optional(),
  k: z.number().int().min(1).max(20).optional(),
  minSimilarity: z.number().min(0).max(1).optional(),
});

export async function POST(request: Request) {
  try {
    if (!isInternal(request)) await getRequestActor();
    const input = await parseJson(request, SearchRequest);
    const hits = await kbSearch({
      query: input.query,
      collectionKinds: input.collectionKinds as CollectionKind[] | undefined,
      collectionIds: input.collectionIds,
      campaignId: input.campaignId,
      k: input.k,
      minSimilarity: input.minSimilarity,
    });
    return Response.json(hits);
  } catch (err) {
    return errorResponse(err);
  }
}
