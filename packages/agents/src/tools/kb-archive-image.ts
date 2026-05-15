/**
 * kb_archive_image — download a public image URL and persist it to Supabase
 * Storage under a stable KB path. Returns the storage path that callers can
 * embed in a kb_write_finding's metadata so the Content / Asset sub-agents
 * can later resolve a signed URL for use as a visual reference.
 *
 * Pairs with x_read_profile: the Researcher reads a profile's posts, then
 * archives any image worth keeping before writing the KB finding.
 */
import { tool } from "ai";
import { z } from "zod";
import { uploadAsset } from "../asset-uploader";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function extFromContentType(ct: string | null): string {
  if (!ct) return "bin";
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  return "bin";
}

export function buildKbArchiveImageTool() {
  return {
    kb_archive_image: tool({
      description:
        "Download a public image (or short video) from a URL and store it in the Supabase 'assets' bucket under a KB-scoped path. Returns { storagePath }. Use this for images you want the Asset / Content sub-agents to be able to reference later; include the returned storagePath in the metadata of the kb_write_finding you write.",
      parameters: z.object({
        url: z.string().url().describe("Public URL of the image or video"),
        namespace: z
          .string()
          .min(1)
          .max(60)
          .describe(
            "Folder under kb/ to group related archives (e.g. 'x-verufinance', 'competitor-acme')",
          ),
        slug: z
          .string()
          .min(1)
          .max(80)
          .describe("Stable identifier for this asset (e.g. tweet id, or post slug)"),
      }),
      execute: async ({ url, namespace, slug }) => {
        try {
          // Peek at content-type to pick a sane extension. uploadAsset will
          // re-download but that's fine — the extra request is cheap and lets
          // us name the file correctly.
          const head = await fetch(url, { method: "HEAD" }).catch(() => null);
          const ct = head?.headers.get("content-type") ?? null;
          const ext = extFromContentType(ct);
          const storagePath = `kb/${slugify(namespace)}/${slugify(slug)}.${ext}`;
          await uploadAsset(url, storagePath);
          return { storagePath, contentType: ct };
        } catch (err) {
          return { error: (err as Error).message, url };
        }
      },
    }),
  };
}
