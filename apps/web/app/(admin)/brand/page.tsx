import { desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  BRAND_MEMORY_SLUGS,
  BRAND_MEMORY_TITLES,
  EMPTY_DESIGN_SYSTEM,
  type BrandMemorySlug,
} from "@marketing/shared-types";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { PageHeader, Badge } from "../ui";
import { BrandForm, type BrandDoc } from "./brand-form";
import { DocumentsForm, type BrandDocRow } from "./documents-form";
import { DesignSystemCard } from "./design-system-card";
import type { InitialDesignSystem } from "./design-system-form";

export const dynamic = "force-dynamic";

const DESCRIPTIONS: Record<BrandMemorySlug, string> = {
  "brand.voice":
    "Tone, vocabulary, banned phrases. Read by the Strategist and Content sub-agents on every run.",
  "brand.icp":
    "Ideal customer profile — who the agents are writing for. Read by the Strategist and Content sub-agents on every run.",
  "brand.visual":
    "Palette, typography, aspect ratios, banned looks. Read by the Asset sub-agent before generating any image.",
  "product.state":
    "What the product does today and what's NOT yet built. Used to keep drafts from claiming features that don't exist.",
  "product.positioning":
    "Category, core promise, against-frame, proof points. Used to align messaging with where the product sits in the market.",
};

export default async function BrandPage() {
  const db = getDb();

  const memoryRows = await db
    .select()
    .from(schema.brandMemory)
    .where(isNull(schema.brandMemory.campaignId));
  const bySlug = new Map(memoryRows.map((r) => [r.slug, r]));

  const docs: BrandDoc[] = BRAND_MEMORY_SLUGS.map((slug) => {
    const row = bySlug.get(slug);
    return {
      slug,
      title: row?.title ?? BRAND_MEMORY_TITLES[slug],
      description: DESCRIPTIONS[slug],
      body: row?.body ?? "",
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });
  const filledCount = docs.filter((d) => d.body.trim().length > 0).length;

  const docRows = await db
    .select()
    .from(schema.brandDocuments)
    .where(isNull(schema.brandDocuments.removedAt))
    .orderBy(desc(schema.brandDocuments.uploadedAt));
  const initialBrandDocs: BrandDocRow[] = docRows.map((r) => ({
    id: r.id,
    filename: r.filename,
    mimeType: r.mimeType,
    sizeBytes: Number(r.sizeBytes),
    status: r.status,
    pageCount: r.pageCount,
    uploadedAt: r.uploadedAt.toISOString(),
  }));

  const [dsRow] = await db
    .select()
    .from(schema.brandDesignSystem)
    .where(eq(schema.brandDesignSystem.slug, "default"))
    .limit(1);
  const colors = dsRow?.colors ?? EMPTY_DESIGN_SYSTEM.colors;
  const typography = dsRow?.typography ?? EMPTY_DESIGN_SYSTEM.typography;
  const logos = dsRow?.logos ?? EMPTY_DESIGN_SYSTEM.logos;
  const tokens = dsRow?.tokens ?? EMPTY_DESIGN_SYSTEM.tokens;
  const signedLogos = await Promise.all(
    logos.map(async (logo) => {
      try {
        return { ...logo, signedUrl: await getSignedAssetUrl(logo.storagePath) };
      } catch {
        return { ...logo, signedUrl: null };
      }
    }),
  );
  const initialDesign: InitialDesignSystem = {
    colors,
    typography,
    logos: signedLogos,
    tokens,
    updatedAt: dsRow?.updatedAt ? dsRow.updatedAt.toISOString() : null,
  };

  return (
    <div className="max-w-4xl space-y-8">
      <PageHeader
        title="Brand"
        description="Upload source documents, then review and approve the brand memory and design system the agents use on every run."
        meta={
          <>
            <Badge tone={filledCount === docs.length ? "success" : "warn"} dot>
              {filledCount} of {docs.length} memory slugs filled
            </Badge>
            <Badge tone={initialBrandDocs.length > 0 ? "info" : "neutral"} dot>
              {initialBrandDocs.length}{" "}
              {initialBrandDocs.length === 1 ? "document" : "documents"}
            </Badge>
          </>
        }
      />

      <Section
        index={1}
        title="Source documents"
        description="Drop in PDFs, Word docs, or Markdown describing your company, products, voice, or customers. Once you have docs uploaded, hit Generate to draft brand memory + design tokens for review."
      >
        <DocumentsForm initialDocs={initialBrandDocs} />
      </Section>

      <Section
        index={2}
        title="Brand memory"
        description="The five documents the agents read before drafting anything. Edit directly, or accept the AI-generated drafts that will appear once you've uploaded source docs."
      >
        <BrandForm initialDocs={docs} />
      </Section>

      <Section
        index={3}
        title="Design system"
        description="Structured palette, typography, and logos. The asset sub-agent reads these tokens verbatim — keep hex values exact."
      >
        <DesignSystemCard initial={initialDesign} />
      </Section>
    </div>
  );
}

function Section({
  index,
  title,
  description,
  children,
}: {
  index: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-ink">
          <span className="text-faint mono mr-2">{index}.</span>
          {title}
        </h2>
        <p className="mt-0.5 text-xs text-mid max-w-2xl">{description}</p>
      </header>
      {children}
    </section>
  );
}
