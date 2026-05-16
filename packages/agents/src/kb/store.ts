/**
 * Knowledge Base store — Drizzle CRUD over kb_collections / kb_documents.
 *
 * Pure data layer. No embedding, no chunking, no LLM. Use ingest.ts to chunk
 * + embed a document, retrieve.ts to search, and tools/kb-tools.ts to expose
 * these to sub-agents.
 *
 * Migration 0015 created the tables. This module wraps them so call sites
 * don't reach into Drizzle internals or have to know about uniqueness rules.
 */
import { eq, and, desc, sql } from "drizzle-orm";
import {
  getDb,
  schema,
  kbCollections,
  kbDocuments,
  kbChunks,
  type KbCollection,
  type KbDocument,
  type KbChunk,
  type NewKbCollection,
  type NewKbDocument,
} from "@marketing/db";

export type CollectionKind =
  | "brand"
  | "product"
  | "persona"
  | "competitor"
  | "sop"
  | "playbook"
  | "past_content"
  | "asset_caption"
  | "visual_reference"
  | "external_doc";

export type DocSource =
  | "manual"
  | "extracted"
  | "agent"
  | "channel_sop"
  | "ga4"
  | "web"
  | "upload";

export type DocStatus = "draft" | "active" | "archived" | "superseded";

// Every read/write below scopes by workspaceId. Callers must supply the
// workspace context — see apps/web/lib/billing/workspace-context.ts for the
// canonical resolver. Internal callers (cron, manager) that still operate on
// the Legacy workspace should pass `LEGACY_WORKSPACE_ID` explicitly.
export async function listCollections(opts: {
  workspaceId: string;
  kind?: CollectionKind;
  campaignId?: string | null;
}): Promise<KbCollection[]> {
  const db = getDb();
  const conds = [eq(kbCollections.workspaceId, opts.workspaceId)];
  if (opts.kind) conds.push(eq(kbCollections.kind, opts.kind));
  if (opts.campaignId === null) {
    conds.push(sql`${kbCollections.campaignId} is null`);
  } else if (opts.campaignId) {
    conds.push(eq(kbCollections.campaignId, opts.campaignId));
  }
  return db
    .select()
    .from(kbCollections)
    .where(and(...conds))
    .orderBy(kbCollections.name);
}

export async function getCollectionBySlug(
  workspaceId: string,
  slug: string,
): Promise<KbCollection | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(kbCollections)
    .where(
      and(
        eq(kbCollections.workspaceId, workspaceId),
        eq(kbCollections.slug, slug),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertCollection(
  input: NewKbCollection,
): Promise<KbCollection> {
  const db = getDb();
  const existing = await getCollectionBySlug(input.workspaceId, input.slug);
  if (existing) {
    const updated = await db
      .update(kbCollections)
      .set({
        name: input.name,
        kind: input.kind,
        scope: input.scope,
        campaignId: input.campaignId ?? null,
        description: input.description ?? null,
        updatedAt: new Date(),
      })
      .where(eq(kbCollections.id, existing.id))
      .returning();
    if (!updated[0]) throw new Error("collection update returned no rows");
    return updated[0];
  }
  const inserted = await db.insert(kbCollections).values(input).returning();
  if (!inserted[0]) throw new Error("collection insert returned no rows");
  return inserted[0];
}

export async function listDocuments(opts: {
  workspaceId: string;
  collectionId?: string;
  status?: DocStatus;
  limit?: number;
}): Promise<KbDocument[]> {
  const db = getDb();
  const conds = [eq(kbDocuments.workspaceId, opts.workspaceId)];
  if (opts.collectionId) conds.push(eq(kbDocuments.collectionId, opts.collectionId));
  if (opts.status) conds.push(eq(kbDocuments.status, opts.status));
  return db
    .select()
    .from(kbDocuments)
    .where(and(...conds))
    .orderBy(desc(kbDocuments.updatedAt))
    .limit(opts.limit ?? 100);
}

export async function getDocument(
  workspaceId: string,
  id: string,
): Promise<KbDocument | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(kbDocuments)
    .where(
      and(eq(kbDocuments.workspaceId, workspaceId), eq(kbDocuments.id, id)),
    )
    .limit(1);
  return row ?? null;
}

// Internal fetch by id only — does NOT enforce workspace scoping. Reserved
// for ingest/post-write hooks (chunkAndEmbed) that operate on a doc the
// caller just inserted and only need the body. DO NOT use from request paths.
export async function getDocumentByIdInternal(
  id: string,
): Promise<KbDocument | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(kbDocuments)
    .where(eq(kbDocuments.id, id))
    .limit(1);
  return row ?? null;
}

export async function getDocumentBySlug(
  workspaceId: string,
  collectionId: string,
  slug: string,
): Promise<KbDocument | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(kbDocuments)
    .where(
      and(
        eq(kbDocuments.workspaceId, workspaceId),
        eq(kbDocuments.collectionId, collectionId),
        eq(kbDocuments.slug, slug),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type UpsertDocumentInput = Omit<NewKbDocument, "id" | "createdAt" | "updatedAt"> & {
  // When replacing the body, ingest.ts will need to re-chunk + re-embed.
  bumpVersion?: boolean;
};

export async function upsertDocument(input: UpsertDocumentInput): Promise<KbDocument> {
  const db = getDb();
  const existing = await getDocumentBySlug(
    input.workspaceId,
    input.collectionId,
    input.slug,
  );
  if (existing) {
    const updated = await db
      .update(kbDocuments)
      .set({
        title: input.title,
        bodyMd: input.bodyMd ?? "",
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        metadata: input.metadata ?? {},
        status: input.status ?? existing.status,
        version: input.bumpVersion ? existing.version + 1 : existing.version,
        updatedAt: new Date(),
      })
      .where(eq(kbDocuments.id, existing.id))
      .returning();
    if (!updated[0]) throw new Error("document update returned no rows");
    return updated[0];
  }
  const inserted = await db.insert(kbDocuments).values(input).returning();
  if (!inserted[0]) throw new Error("document insert returned no rows");
  return inserted[0];
}

export async function archiveDocument(
  workspaceId: string,
  id: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(kbDocuments)
    .set({ status: "archived", updatedAt: new Date() })
    .where(
      and(eq(kbDocuments.workspaceId, workspaceId), eq(kbDocuments.id, id)),
    );
}

export async function listChunks(documentId: string): Promise<KbChunk[]> {
  const db = getDb();
  return db
    .select()
    .from(kbChunks)
    .where(eq(kbChunks.documentId, documentId))
    .orderBy(kbChunks.chunkIndex);
}

export async function deleteChunksFor(documentId: string): Promise<void> {
  const db = getDb();
  // Delete chunks (cascade) AND their embeddings (no FK; manual cleanup).
  await db
    .delete(schema.embeddings)
    .where(
      and(
        eq(schema.embeddings.sourceType, "kb_chunk"),
        sql`${schema.embeddings.sourceId} in (
          select id::text from ${kbChunks} where document_id = ${documentId}
        )`,
      ),
    );
  await db.delete(kbChunks).where(eq(kbChunks.documentId, documentId));
}

/**
 * Ensure a collection exists (idempotent helper for seed scripts and the
 * channel-SOP migration). Returns the collection id.
 */
export async function ensureCollection(input: NewKbCollection): Promise<string> {
  const c = await upsertCollection(input);
  return c.id;
}
