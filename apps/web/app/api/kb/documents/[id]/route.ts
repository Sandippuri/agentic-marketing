/**
 * GET    /api/kb/documents/[id] — fetch a document with its chunks
 * PATCH  /api/kb/documents/[id] — update body / metadata / status; re-ingest
 * DELETE /api/kb/documents/[id] — soft-archive (status='archived')
 */
import { z } from "zod";
import {
  archiveDocument,
  chunkAndEmbed,
  deleteChunksFor,
  getDocument,
  listChunks,
  upsertDocument,
} from "@marketing/agents/kb";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/billing";

export const dynamic = "force-dynamic";

const STATUS = z.enum(["draft", "active", "archived", "superseded"]);

const PatchDocument = z.object({
  title: z.string().min(1).optional(),
  bodyMd: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  status: STATUS.optional(),
  bumpVersion: z.boolean().optional(),
  ingest: z.boolean().default(true),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const { id } = await params;
    const doc = await getDocument(workspaceId, id);
    if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
    const chunks = await listChunks(id);
    return Response.json({ document: doc, chunks });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const { id } = await params;
    const existing = await getDocument(workspaceId, id);
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
    const input = await parseJson(request, PatchDocument);

    const updated = await upsertDocument({
      workspaceId: existing.workspaceId,
      collectionId: existing.collectionId,
      slug: existing.slug,
      title: input.title ?? existing.title,
      source: existing.source,
      sourceRef: existing.sourceRef ?? null,
      bodyMd: input.bodyMd ?? existing.bodyMd,
      metadata: input.metadata ?? (existing.metadata as Record<string, unknown>),
      status: input.status ?? existing.status,
      bumpVersion: input.bumpVersion ?? false,
    });

    let ingest: { chunks: number; embedded: number } | null = null;
    if (input.ingest && updated.status === "active" && updated.bodyMd.trim()) {
      ingest = await chunkAndEmbed(updated.id);
    } else if (updated.status !== "active") {
      // Drop embeddings when a doc moves out of active.
      await deleteChunksFor(updated.id);
    }

    return Response.json({ document: updated, ingest });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const { id } = await params;
    await archiveDocument(workspaceId, id);
    await deleteChunksFor(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
