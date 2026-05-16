import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pino from "pino";
import { getBrandMemory } from "./brand-store";

const log = pino({ name: "memory" });

// Memory directory lives beside the compiled entry-point.
// When running via `tsx src/index.ts` from the manager root:
//   __dirname → <manager>/src  →  memory is at <manager>/memory
// Resolve from the manager package root.
const MEMORY_ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..", "memory") : "";

/**
 * Read a single memory file. Returns its contents or an empty string if
 * the file doesn't exist (keeps sub-agents from crashing on missing files).
 */
export async function loadMemory(relativePath: string): Promise<string> {
  const full = join(MEMORY_ROOT, relativePath);
  try {
    const content = await readFile(full, "utf8");
    log.debug({ path: relativePath }, "loaded memory file");
    return content;
  } catch {
    log.debug({ path: relativePath }, "memory file not found — returning empty");
    return "";
  }
}

/**
 * Load a directory of memory files and concatenate them with headers.
 * Useful for reading all learnings or all playbooks at once.
 */
export async function loadMemoryDir(relativeDirPath: string): Promise<string> {
  const full = join(MEMORY_ROOT, relativeDirPath);
  try {
    const files = await readdir(full);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
    if (mdFiles.length === 0) return "";
    const parts = await Promise.all(
      mdFiles.map(async (file) => {
        const content = await readFile(join(full, file), "utf8");
        return `## ${file}\n\n${content}`;
      }),
    );
    return parts.join("\n\n---\n\n");
  } catch {
    log.debug({ dir: relativeDirPath }, "memory directory not found");
    return "";
  }
}

// Brand-memory slugs the strategist + content sub-agents always need in
// their system prompt. Visual is loaded separately by the asset sub-agent.
const BASE_MEMORY_SECTIONS = [
  { slug: "brand.voice", header: "Brand Voice" },
  { slug: "brand.icp", header: "ICP" },
  { slug: "product.state", header: "Product State" },
  { slug: "product.positioning", header: "Product Positioning" },
  { slug: "market.context", header: "Market Context" },
] as const;

/**
 * Build the standard memory context block injected into every sub-agent call.
 * Reads from the brand-memory store (DB-backed via CP) with file fallback.
 *
 * `workspaceId` is mandatory for multi-tenant correctness — without it the CP
 * endpoint falls back to LEGACY_WORKSPACE_ID and every sub-agent gets user1's
 * brand voice/ICP regardless of who triggered the run.
 */
export async function buildBaseMemory(
  scope: { workspaceId?: string | null } = {},
): Promise<string> {
  const docs = await getBrandMemory({ workspaceId: scope.workspaceId });
  const bySlug = new Map(docs.map((d) => [d.slug, d]));

  return BASE_MEMORY_SECTIONS.map(({ slug, header }) => {
    const body = bySlug.get(slug)?.body ?? "";
    return body.trim() ? `# ${header}\n\n${body}` : "";
  })
    .filter(Boolean)
    .join("\n\n---\n\n");
}
