/**
 * GET  /api/kb/documents?collectionId=…&status=… — list documents
 * POST /api/kb/documents — upsert by (collectionId, slug); triggers ingest
 *
 * Ingest is invoked synchronously (chunkAndEmbed) for now; Phase 1 wires a
 * Vercel Workflow at apps/web/workflows/kb-ingest.ts that the UI can fire-
 * and-forget for large bodies.
 */
import { z } from "zod";
import { listDocuments, upsertDocument } from "@marketing/agents/kb";
import { chunkAndEmbed } from "@marketing/agents/kb";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/billing";

export const dynamic = "force-dynamic";

const STATUS = z.enum(["draft", "active", "archived", "superseded"]);
const SOURCE = z.enum(["manual", "extracted", "agent", "channel_sop", "ga4", "web", "upload"]);

const UpsertDocument = z.object({
  collectionId: z.string().uuid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  source: SOURCE.default("manual"),
  sourceRef: z.string().optional(),
  bodyMd: z.string().default(""),
  metadata: z.record(z.unknown()).optional(),
  status: STATUS.default("active"),
  bumpVersion: z.boolean().optional(),
  /** When true (default), re-chunk + re-embed on upsert. */
  ingest: z.boolean().default(true),
});

export async function GET(request: Request) {
  try {
    await getRequestActor();
    const url = new URL(request.url);
    const collectionId = url.searchParams.get("collectionId") ?? undefined;
    const status = url.searchParams.get("status") as
      | "draft"
      | "active"
      | "archived"
      | "superseded"
      | null;
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const docs = await listDocuments({
      collectionId,
      status: status ?? undefined,
      limit,
    });
    return Response.json(docs);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const input = await parseJson(request, UpsertDocument);
    const doc = await upsertDocument({
      workspaceId,
      collectionId: input.collectionId,
      slug: input.slug,
      title: input.title,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      bodyMd: input.bodyMd,
      metadata: input.metadata ?? {},
      status: input.status,
      bumpVersion: input.bumpVersion ?? false,
      createdBy: actor.id ?? null,
    });
    let ingest: { chunks: number; embedded: number } | null = null;
    if (input.ingest && (input.bodyMd ?? "").trim() && input.status === "active") {
      ingest = await chunkAndEmbed(doc.id);
    }
    return Response.json({ document: doc, ingest }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
