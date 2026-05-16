/**
 * Agent-callable Knowledge Base tools.
 *
 * Each sub-agent that needs the KB imports buildKbTools(ctx) and spreads the
 * result into its `tools: { ... }` object passed to generateText. The same
 * functions are used by the goal-loop workflow's tool registry (Phase 2).
 *
 * Tool surface:
 *   - kb_search          — semantic search across collections (read)
 *   - kb_read_document   — fetch full body of a doc by id or slug (read)
 *   - kb_list            — enumerate collections / docs (read)
 *   - kb_write_finding   — append a research finding (write)
 *   - kb_propose_update  — write a draft for human review (write, gated)
 *
 * Writes are namespaced by collection kind. Researcher writes findings into
 * the `persona`/`competitor` collections; analyst into `past_content`. The
 * Art Director reads `visual_reference`. The kb_propose_update tool uses
 * status='draft' so a human can promote to 'active' from the admin UI.
 */
import { tool } from "ai";
import { z } from "zod";
import type { CollectionKind } from "../kb/store";
import {
  kbSearch,
  type KbSearchHit,
  listCollections,
  listDocuments,
  getDocument,
  upsertDocument,
  ensureCollection,
} from "../kb";
import { chunkAndEmbed } from "../kb/ingest";

const COLLECTION_KINDS = [
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
] as const;

export type KbToolContext = {
  /** Workspace scope. Mandatory from PR 4 — kbSearch refuses without it. */
  workspaceId: string;
  /** When set, kb_search filters to this campaign + global collections. */
  campaignId?: string;
  /** When set, write tools record this id as created_by. */
  actorId?: string;
};

export function buildKbTools(ctx: KbToolContext) {
  return {
    kb_search: tool({
      description:
        "Semantic search the Knowledge Base. Use this BEFORE drafting content, planning a campaign, or designing an asset. Pass a natural-language query and optionally restrict to collection kinds (e.g. ['brand','sop'] for tone guidance, ['product'] for feature facts, ['persona','competitor'] for audience research, ['visual_reference'] for image references). Default mode is hybrid (vector + BM25 fused with RRF) and a reranker is applied when KB_RERANKER is configured. Pass expandToSection=true when you want a coherent section instead of a single chunk.",
      parameters: z.object({
        query: z.string().min(1),
        collectionKinds: z.array(z.enum(COLLECTION_KINDS)).optional(),
        k: z.number().int().min(1).max(20).optional().default(6),
        mode: z.enum(["vector", "bm25", "hybrid"]).optional(),
        expandToSection: z.boolean().optional(),
      }),
      execute: async ({ query, collectionKinds, k, mode, expandToSection }) => {
        const hits = await kbSearch({
          query,
          workspaceId: ctx.workspaceId,
          collectionKinds: collectionKinds as CollectionKind[] | undefined,
          campaignId: ctx.campaignId,
          k,
          mode,
          expandToSection,
        });
        return hits.map(simplifyHit);
      },
    }),

    kb_read_document: tool({
      description:
        "Fetch the full body of a KB document. Use this when kb_search returned a relevant chunk and you need the rest of the document. Accepts either a documentId or {collectionSlug, docSlug}.",
      parameters: z.object({
        documentId: z.string().optional(),
        collectionSlug: z.string().optional(),
        docSlug: z.string().optional(),
      }),
      execute: async ({ documentId }) => {
        if (!documentId) {
          return { error: "documentId required (slug-based lookup not yet wired)" };
        }
        const doc = await getDocument(ctx.workspaceId, documentId);
        if (!doc) return { error: "not found" };
        return {
          id: doc.id,
          title: doc.title,
          slug: doc.slug,
          collectionId: doc.collectionId,
          status: doc.status,
          version: doc.version,
          body: doc.bodyMd,
          metadata: doc.metadata,
        };
      },
    }),

    kb_list: tool({
      description:
        "List collections (when no collectionId) or documents within a collection. Use this to discover what reference material exists before searching.",
      parameters: z.object({
        collectionId: z.string().optional(),
        kind: z.enum(COLLECTION_KINDS).optional(),
        limit: z.number().int().min(1).max(100).optional().default(50),
      }),
      execute: async ({ collectionId, kind, limit }) => {
        if (collectionId) {
          const docs = await listDocuments({
            workspaceId: ctx.workspaceId,
            collectionId,
            status: "active",
            limit,
          });
          return docs.map((d) => ({
            id: d.id,
            slug: d.slug,
            title: d.title,
            updatedAt: d.updatedAt,
            version: d.version,
          }));
        }
        const cols = await listCollections({
          workspaceId: ctx.workspaceId,
          kind: kind as CollectionKind | undefined,
        });
        return cols.map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          kind: c.kind,
          scope: c.scope,
          campaignId: c.campaignId,
          description: c.description,
        }));
      },
    }),

    kb_write_finding: tool({
      description:
        "Persist a research finding directly to the KB as an ACTIVE document. Use when the finding is well-formed and high confidence (e.g. summarised competitor positioning, a confirmed persona pain point). For lower-confidence drafts, use kb_propose_update instead so a human reviews before activation.",
      parameters: z.object({
        collectionSlug: z.string().describe("e.g. 'competitors', 'personas', 'past-content-wins'"),
        collectionKind: z.enum(COLLECTION_KINDS),
        slug: z.string().describe("kebab-case unique slug within the collection"),
        title: z.string(),
        body_md: z.string(),
        metadata: z.record(z.unknown()).optional(),
      }),
      execute: async ({ collectionSlug, collectionKind, slug, title, body_md, metadata }) => {
        const collectionId = await ensureCollection({
          workspaceId: ctx.workspaceId,
          slug: collectionSlug,
          name: humanise(collectionSlug),
          kind: collectionKind as CollectionKind,
          scope: ctx.campaignId ? "campaign" : "global",
          campaignId: ctx.campaignId ?? null,
        });
        const doc = await upsertDocument({
          workspaceId: ctx.workspaceId,
          collectionId,
          slug,
          title,
          source: "agent",
          bodyMd: body_md,
          metadata: metadata ?? {},
          status: "active",
          createdBy: ctx.actorId ?? null,
          bumpVersion: true,
        });
        // Re-chunk and re-embed so the finding is searchable immediately.
        const ingestResult = await chunkAndEmbed(doc.id);
        return { documentId: doc.id, version: doc.version, ...ingestResult };
      },
    }),

    kb_propose_update: tool({
      description:
        "Propose a KB document update for human review. Same shape as kb_write_finding but writes status='draft' so the change is not yet visible to other agents.",
      parameters: z.object({
        collectionSlug: z.string(),
        collectionKind: z.enum(COLLECTION_KINDS),
        slug: z.string(),
        title: z.string(),
        body_md: z.string(),
        metadata: z.record(z.unknown()).optional(),
      }),
      execute: async ({ collectionSlug, collectionKind, slug, title, body_md, metadata }) => {
        const collectionId = await ensureCollection({
          workspaceId: ctx.workspaceId,
          slug: collectionSlug,
          name: humanise(collectionSlug),
          kind: collectionKind as CollectionKind,
          scope: ctx.campaignId ? "campaign" : "global",
          campaignId: ctx.campaignId ?? null,
        });
        const doc = await upsertDocument({
          workspaceId: ctx.workspaceId,
          collectionId,
          slug,
          title,
          source: "agent",
          bodyMd: body_md,
          metadata: metadata ?? {},
          status: "draft",
          createdBy: ctx.actorId ?? null,
          bumpVersion: false,
        });
        return { documentId: doc.id, status: doc.status };
      },
    }),
  };
}

function simplifyHit(h: KbSearchHit) {
  return {
    documentId: h.documentId,
    title: h.documentTitle,
    collectionKind: h.collectionKind,
    collectionName: h.collectionName,
    similarity: Number(h.similarity.toFixed(3)),
    body: h.expandedSection ?? h.body,
    metadata: h.metadata,
  };
}

function humanise(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
