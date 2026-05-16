import { listCollections, listDocuments } from "@marketing/agents/kb";
import { getWorkspaceContext } from "@/lib/billing";
import { PageHeader } from "../../ui";
import { VisualReferenceGallery } from "./gallery";

export const dynamic = "force-dynamic";

export default async function VisualReferencesPage() {
  const { workspaceId } = await getWorkspaceContext();
  const cols = await listCollections({ workspaceId, kind: "visual_reference" });
  const groups: Array<{
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
      caption: string;
      updatedAt: string;
    }>;
  }> = [];
  for (const c of cols) {
    const docs = await listDocuments({
      workspaceId,
      collectionId: c.id,
      status: "active",
    });
    groups.push({
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
          caption: d.bodyMd ?? "",
          updatedAt: d.updatedAt.toISOString(),
        };
      }),
    });
  }

  return (
    <>
      <PageHeader
        title="Visual references"
        description="Real product imagery, architecture diagrams, brand photography, signature motifs. The Art Director sub-agent pulls from here before every image generation, and the image model uses these as visual conditioning — not just inspiration."
      />
      <VisualReferenceGallery groups={groups} />
    </>
  );
}
