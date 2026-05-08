/**
 * Seed the Knowledge Base with content from legacy stores.
 *
 *   - apps/manager/memory/brand/*.md         → kind='brand'
 *   - apps/manager/memory/product/*.md       → kind='product'
 *   - apps/manager/memory/channel-sops/*.md  → kind='sop'
 *   - apps/manager/memory/playbooks/*.md     → kind='playbook'
 *   - brand_memory rows                       → archived (KB owns from now on)
 *
 * Idempotent: re-runs upsert by (collection_slug, doc_slug). Each document
 * is chunk+embedded inline using the same pipeline the API routes use.
 *
 * Usage:
 *   DATABASE_URL=<url> OPENAI_API_KEY=<key> \
 *     pnpm --filter @marketing/db exec tsx scripts/seed-kb.ts
 *
 * Optional flags:
 *   --skip-embed   Don't embed chunks (chunk-only dry run).
 *   --no-archive   Skip the brand_memory archival step.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { getDb, schema } from "@marketing/db";
import {
  ensureCollection,
  upsertDocument,
  chunkAndEmbed,
  type CollectionKind,
} from "@marketing/agents/kb";

const args = new Set(process.argv.slice(2));
const SKIP_EMBED = args.has("--skip-embed");
const NO_ARCHIVE = args.has("--no-archive");

// Locate the monorepo root from apps/web/scripts/.
const REPO_ROOT = resolve(import.meta.dirname ?? ".", "..", "..", "..");
const MANAGER_MEMORY = join(REPO_ROOT, "apps", "manager", "memory");

type DirSpec = {
  dir: string;
  collectionSlug: string;
  collectionName: string;
  collectionKind: CollectionKind;
  description: string;
};

const DIR_SPECS: DirSpec[] = [
  {
    dir: join(MANAGER_MEMORY, "brand"),
    collectionSlug: "brand-core",
    collectionName: "Brand Core",
    collectionKind: "brand",
    description: "Voice, ICP, visual language, positioning.",
  },
  {
    dir: join(MANAGER_MEMORY, "product"),
    collectionSlug: "product-knowledge",
    collectionName: "Product Knowledge",
    collectionKind: "product",
    description: "Product state, features, positioning.",
  },
  {
    dir: join(MANAGER_MEMORY, "channel-sops"),
    collectionSlug: "channel-sops",
    collectionName: "Channel SOPs",
    collectionKind: "sop",
    description: "Per-channel writing rules (LinkedIn, X, email, blog).",
  },
  {
    dir: join(MANAGER_MEMORY, "playbooks"),
    collectionSlug: "playbooks",
    collectionName: "Campaign Playbooks",
    collectionKind: "playbook",
    description: "Reusable campaign templates and patterns.",
  },
];

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
}

function slugFromFilename(name: string): string {
  return basename(name, ".md").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function titleFromBody(body: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(body);
  return m && m[1] ? m[1].trim() : fallback;
}

async function seedFromFiles(): Promise<{ docs: number; chunks: number }> {
  let docs = 0;
  let totalChunks = 0;

  for (const spec of DIR_SPECS) {
    const files = await listMarkdown(spec.dir);
    if (files.length === 0) {
      console.log(`  · no files in ${spec.dir} — skipping`);
      continue;
    }
    const collectionId = await ensureCollection({
      slug: spec.collectionSlug,
      name: spec.collectionName,
      kind: spec.collectionKind,
      scope: "global",
      campaignId: null,
      description: spec.description,
    });
    console.log(`  collection ${spec.collectionSlug} (${files.length} file(s))`);
    for (const fname of files) {
      const body = await readFile(join(spec.dir, fname), "utf8");
      if (!body.trim()) continue;
      const slug = slugFromFilename(fname);
      const doc = await upsertDocument({
        collectionId,
        slug,
        title: titleFromBody(body, slug),
        source: "channel_sop",
        sourceRef: `apps/manager/memory/${basename(spec.dir)}/${fname}`,
        bodyMd: body,
        metadata: { migratedFrom: "manager-memory" },
        status: "active",
        bumpVersion: false,
      });
      docs++;
      if (!SKIP_EMBED) {
        const result = await chunkAndEmbed(doc.id);
        totalChunks += result.chunks;
        console.log(`    ✓ ${slug} (${result.chunks} chunks)`);
      } else {
        console.log(`    ✓ ${slug} (skipped embed)`);
      }
    }
  }

  return { docs, chunks: totalChunks };
}

async function seedFromBrandMemory(): Promise<{ docs: number; chunks: number }> {
  const db = getDb();
  const rows = await db.select().from(schema.brandMemory);
  if (rows.length === 0) {
    console.log("  · no brand_memory rows — skipping");
    return { docs: 0, chunks: 0 };
  }
  console.log(`  brand_memory → kb (${rows.length} row(s))`);
  const collectionId = await ensureCollection({
    slug: "brand-memory-legacy",
    name: "Brand Memory (legacy)",
    kind: "brand",
    scope: "global",
    campaignId: null,
    description: "Imported from the brand_memory table (Phase 0 KB cutover).",
  });
  let docs = 0;
  let totalChunks = 0;
  for (const row of rows) {
    if (!row.body?.trim()) continue;
    const doc = await upsertDocument({
      collectionId,
      slug: row.slug,
      title: row.title || row.slug,
      source: "extracted",
      sourceRef: `brand_memory:${row.id}`,
      bodyMd: row.body,
      metadata: { campaignId: row.campaignId, migratedFrom: "brand_memory" },
      status: "active",
      bumpVersion: false,
    });
    docs++;
    if (!SKIP_EMBED) {
      const result = await chunkAndEmbed(doc.id);
      totalChunks += result.chunks;
      console.log(`    ✓ ${row.slug} (${result.chunks} chunks)`);
    }
  }
  return { docs, chunks: totalChunks };
}

async function archiveBrandMemoryRows(): Promise<number> {
  if (NO_ARCHIVE) return 0;
  // We don't add a status column to brand_memory in Phase 0; the cleanest
  // archival is to leave the rows in place but stop reading from them.
  // brand-guidance.ts already prefers KB results. Future cleanup: drop
  // brand_memory entirely once legacy callers are gone.
  return 0;
}

async function main() {
  console.log("seed-kb starting");
  console.log(`  embed: ${SKIP_EMBED ? "off" : "on"}`);
  const filesResult = await seedFromFiles();
  const memoryResult = await seedFromBrandMemory();
  const archived = await archiveBrandMemoryRows();
  console.log(
    `seed-kb done — files: ${filesResult.docs} docs / ${filesResult.chunks} chunks · memory: ${memoryResult.docs} docs / ${memoryResult.chunks} chunks · archived: ${archived}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
