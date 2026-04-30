import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pino from "pino";

const log = pino({ name: "memory" });

// Memory directory lives beside the compiled entry-point.
// When running via `tsx src/index.ts` from the manager root:
//   __dirname → <manager>/src  →  memory is at <manager>/memory
// Resolve from the manager package root.
const MEMORY_ROOT = resolve(import.meta.dirname, "..", "memory");

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

/**
 * Build the standard memory context block injected into every sub-agent call.
 */
export async function buildBaseMemory(): Promise<string> {
  const [voice, icp, productState, productPositioning] = await Promise.all([
    loadMemory("brand/voice.md"),
    loadMemory("brand/icp.md"),
    loadMemory("product/state.md"),
    loadMemory("product/positioning.md"),
  ]);

  return [
    voice && `# Brand Voice\n\n${voice}`,
    icp && `# ICP\n\n${icp}`,
    productState && `# Product State\n\n${productState}`,
    productPositioning && `# Product Positioning\n\n${productPositioning}`,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}
