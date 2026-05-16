/**
 * POST /api/kb/visual-references — register a visual reference in the KB.
 *
 * Body: {
 *   collectionSlug?: string,    // defaults to "visual-references"
 *   slug: string,
 *   title: string,
 *   imageUrl: string,           // public URL OR Supabase storage path under /assets/
 *   caption: string,            // markdown describing what the image shows
 *   tags?: string[],
 *   useFor?: string[]           // e.g. ["product hero","architecture"]
 * }
 *
 * Stored as a kb_documents row with kind='visual_reference', source='upload',
 * body_md=caption, metadata={image_url, tags, use_for}. The image itself
 * lives in Supabase Storage; this route does NOT upload bytes — pass a URL
 * the Art Director can fetch later. Use Supabase Storage UI or a separate
 * upload endpoint to put files there.
 *
 * After insert, kicks off chunk+embed so kb_search hits it immediately.
 */
import { z } from "zod";
import {
  ensureCollection,
  upsertDocument,
  chunkAndEmbed,
} from "@marketing/agents/kb";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/billing";

export const dynamic = "force-dynamic";

const Body = z.object({
  collectionSlug: z.string().min(1).default("visual-references"),
  collectionName: z.string().default("Visual References"),
  slug: z.string().min(1),
  title: z.string().min(1),
  imageUrl: z.string().url(),
  caption: z.string().min(1),
  tags: z.array(z.string()).optional(),
  useFor: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  try {
    const actor = await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const input = await parseJson(request, Body);

    const collectionId = await ensureCollection({
      workspaceId,
      slug: input.collectionSlug ?? "visual-references",
      name: input.collectionName ?? "Visual References",
      kind: "visual_reference",
      scope: "global",
      campaignId: null,
      description:
        "Real product imagery, architecture diagrams, brand photography, and approved past assets. Read by the Art Director sub-agent before image generation.",
    });

    const doc = await upsertDocument({
      workspaceId,
      collectionId,
      slug: input.slug,
      title: input.title,
      source: "upload",
      sourceRef: input.imageUrl,
      bodyMd: input.caption,
      metadata: {
        image_url: input.imageUrl,
        tags: input.tags ?? [],
        use_for: input.useFor ?? [],
      },
      status: "active",
      createdBy: actor.id ?? null,
      bumpVersion: true,
    });

    const ingest = await chunkAndEmbed(doc.id);

    return Response.json({ document: doc, ingest }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const ListQuery = z.object({});

export async function GET() {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const { listCollections, listDocuments } = await import(
      "@marketing/agents/kb"
    );
    const cols = await listCollections({ workspaceId, kind: "visual_reference" });
    if (cols.length === 0) return Response.json([]);
    const out: Array<{
      collectionId: string;
      collectionSlug: string;
      collectionName: string;
      docs: Array<{
        id: string;
        slug: string;
        title: string;
        imageUrl: string | null;
        tags: string[];
        useFor: string[];
        updatedAt: string;
      }>;
    }> = [];
    for (const c of cols) {
      const docs = await listDocuments({
        workspaceId,
        collectionId: c.id,
        status: "active",
      });
      out.push({
        collectionId: c.id,
        collectionSlug: c.slug,
        collectionName: c.name,
        docs: docs.map((d) => {
          const meta = (d.metadata ?? {}) as {
            image_url?: string;
            tags?: string[];
            use_for?: string[];
          };
          return {
            id: d.id,
            slug: d.slug,
            title: d.title,
            imageUrl: meta.image_url ?? null,
            tags: meta.tags ?? [],
            useFor: meta.use_for ?? [],
            updatedAt: d.updatedAt.toISOString(),
          };
        }),
      });
    }
    return Response.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
