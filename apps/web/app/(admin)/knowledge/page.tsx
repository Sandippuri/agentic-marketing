import { listCollections, listDocuments } from "@marketing/agents/kb";
import { PageHeader } from "../ui";
import { KnowledgeBrowser } from "./browser";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const collections = await listCollections();
  // Pre-load the first collection's documents so the page renders
  // something useful even before the browser hydrates.
  const initialDocs = collections[0]
    ? await listDocuments({
        collectionId: collections[0].id,
        status: "active",
        limit: 50,
      })
    : [];

  return (
    <>
      <PageHeader
        title="Knowledge base"
        description="Single source of truth for brand voice, product knowledge, channel SOPs, personas, competitors, and visual references. Read by every sub-agent on every run via semantic search."
      />
      <KnowledgeBrowser
        initialCollections={collections.map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          kind: c.kind,
          scope: c.scope,
          description: c.description,
        }))}
        initialDocs={initialDocs.map((d) => ({
          id: d.id,
          slug: d.slug,
          title: d.title,
          status: d.status,
          source: d.source,
          version: d.version,
          updatedAt: d.updatedAt.toISOString(),
        }))}
      />
    </>
  );
}
