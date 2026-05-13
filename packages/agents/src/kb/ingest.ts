/**
 * Knowledge Base ingest — markdown chunking + embedding write-through.
 *
 * Strategy:
 *  - Heading-aware chunker: splits on H1/H2/H3 then packs to ~maxTokens
 *    using a rough chars-per-token approximation (4 chars ≈ 1 token).
 *  - Each chunk is written to kb_chunks with chunk_index ordered.
 *  - Each chunk is embedded with text-embedding-3-small (1536 dims) and the
 *    vector is written to the existing `embeddings` table with
 *    source_type='kb_chunk' and source_id = kb_chunks.id.
 *
 * Idempotent on re-run: deletes prior chunks + embeddings for the document
 * before re-chunking. Call this whenever a document body or status changes.
 */
import pino from "pino";
import { getDb, kbChunks, schema, type KbDocument } from "@marketing/db";
import { embedBatch, getEmbeddingConfig } from "./embed-client";
import { deleteChunksFor, getDocument } from "./store";

const log = pino({ name: "kb-ingest" });

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 500;

type IngestOptions = {
  maxTokens?: number;
  /** Skip embedding (chunks only). Useful for tests / dry runs. */
  skipEmbed?: boolean;
};

export async function chunkAndEmbed(
  documentId: string,
  opts: IngestOptions = {},
): Promise<{ chunks: number; embedded: number }> {
  const doc = await getDocument(documentId);
  if (!doc) throw new Error(`kb document not found: ${documentId}`);

  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const pieces = chunkMarkdown(doc.bodyMd ?? "", maxChars);
  if (pieces.length === 0) {
    log.warn({ documentId }, "kb document has no body; nothing to chunk");
    return { chunks: 0, embedded: 0 };
  }

  // Idempotency: drop existing chunks + embeddings for this doc.
  await deleteChunksFor(documentId);

  const db = getDb();
  const inserted = await db
    .insert(kbChunks)
    .values(
      pieces.map((p, i) => ({
        documentId,
        chunkIndex: i,
        bodyMd: p.body,
        tokenCount: estimateTokens(p.body),
        metadata: { heading: p.heading ?? null },
      })),
    )
    .returning({ id: kbChunks.id, chunkIndex: kbChunks.chunkIndex, bodyMd: kbChunks.bodyMd });

  if (opts.skipEmbed) return { chunks: inserted.length, embedded: 0 };

  const vectors = await embedBatch(inserted.map((c) => contextualText(doc, c.bodyMd)));
  if (vectors.length !== inserted.length) {
    throw new Error(
      `embed mismatch: ${vectors.length} vectors for ${inserted.length} chunks`,
    );
  }
  const { model } = await getEmbeddingConfig();
  await db.insert(schema.embeddings).values(
    inserted.map((c, i) => {
      const vec = vectors[i];
      if (!vec) throw new Error(`missing vector at index ${i}`);
      return {
        sourceType: "kb_chunk" as const,
        sourceId: c.id,
        chunkIndex: c.chunkIndex,
        text: c.bodyMd,
        embedding: vec,
        metadata: {
          documentId,
          documentSlug: doc.slug,
          documentTitle: doc.title,
          collectionId: doc.collectionId,
        },
        model,
      };
    }),
  );

  return { chunks: inserted.length, embedded: vectors.length };
}

/**
 * Prepend doc title + slug to chunk body so retrieval matches naturally
 * even when the chunk text alone lacks context.
 */
function contextualText(doc: KbDocument, body: string): string {
  return `# ${doc.title}\n[${doc.slug}]\n\n${body}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

type Piece = { heading?: string; body: string };

/**
 * Split markdown on H1/H2/H3 boundaries, then pack runs of consecutive
 * sections under one chunk while we have room. Falls back to char-window
 * splitting for sections that exceed maxChars on their own.
 */
export function chunkMarkdown(md: string, maxChars: number): Piece[] {
  const text = md.trim();
  if (!text) return [];

  const lines = text.split("\n");
  const sections: Piece[] = [];
  let current: Piece = { body: "" };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m && m[2]) {
      if (current.body.trim()) sections.push(current);
      current = { heading: m[2].trim(), body: line + "\n" };
    } else {
      current.body += line + "\n";
    }
  }
  if (current.body.trim()) sections.push(current);

  // Pack into chunks <= maxChars.
  const packed: Piece[] = [];
  let buf: Piece | null = null;
  for (const sec of sections) {
    const needed = sec.body.length + (buf ? buf.body.length : 0);
    if (sec.body.length > maxChars) {
      // Flush buffer first.
      if (buf) {
        packed.push(buf);
        buf = null;
      }
      // Hard-split this oversized section into char windows, preserving heading.
      for (let i = 0; i < sec.body.length; i += maxChars) {
        packed.push({
          heading: sec.heading,
          body: sec.body.slice(i, i + maxChars),
        });
      }
      continue;
    }
    if (!buf) {
      buf = { heading: sec.heading, body: sec.body };
      continue;
    }
    if (needed <= maxChars) {
      buf.body += sec.body;
    } else {
      packed.push(buf);
      buf = { heading: sec.heading, body: sec.body };
    }
  }
  if (buf) packed.push(buf);

  return packed.map((p) => ({ heading: p.heading, body: p.body.trim() }));
}
