/**
 * GET  /api/kb/collections — list collections (optional ?kind=, ?campaignId=)
 * POST /api/kb/collections — create or upsert a collection by slug
 */
import { z } from "zod";
import {
  listCollections,
  upsertCollection,
  type CollectionKind,
} from "@marketing/agents/kb";
import { getRequestActor } from "@/lib/auth";
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

const UpsertCollection = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  kind: KIND,
  scope: z.enum(["global", "campaign"]).default("global"),
  campaignId: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
});

export async function GET(request: Request) {
  try {
    await getRequestActor();
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? undefined;
    const campaignId = url.searchParams.get("campaignId") ?? undefined;
    const cols = await listCollections({
      kind: kind as CollectionKind | undefined,
      campaignId,
    });
    return Response.json(cols);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    await getRequestActor();
    const input = await parseJson(request, UpsertCollection);
    const row = await upsertCollection({
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      scope: input.scope,
      campaignId: input.campaignId ?? null,
      description: input.description ?? null,
    });
    return Response.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
