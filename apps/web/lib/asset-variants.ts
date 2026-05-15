import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, schema } from "@marketing/db";
import { generateVideoVariant } from "./video-variant";

// The content sub-agent inserts visual cues like "**[IMAGE 1: a diagram of...]**"
// directly in the body. Used to surface the most informative one to the video
// prompt — Veo prefers a concrete motion seed over the bare post title.
function extractImageMarkers(body: string | null | undefined): string[] {
  if (!body) return [];
  const markers: string[] = [];
  const re = /\[IMAGE(?:\s*\d+)?:\s*([^\]]+)\]/gi;
  for (const match of body.matchAll(re)) {
    const desc = match[1]?.trim();
    if (desc) markers.push(desc);
  }
  return markers;
}

export type GenerateAssetVariantsInput = {
  contentId: string;
  /** Workspace scope; mandatory from PR 4. Threaded by caller. */
  workspaceId: string;
  /** Optional override for the subject prompt; defaults to the content title. */
  subject?: string;
};

/**
 * Fire-and-forget kickoff for the promotional video clip. The AD pipeline
 * produces stills; this brings the motion side along on every run so the
 * approval card has both modalities for channels that want them.
 */
export async function kickVideoVariant(contentId: string): Promise<void> {
  try {
    const db = getDb();
    const [row] = await db
      .select({
        title: schema.contentItems.title,
        type: schema.contentItems.type,
        bodyMd: schema.contentItems.bodyMd,
        campaignId: schema.contentItems.campaignId,
        workspaceId: schema.contentItems.workspaceId,
      })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, contentId))
      .limit(1);
    if (!row) return;
    const markers = extractImageMarkers(row.bodyMd);
    void generateVideoVariant({
      contentId,
      contentType: row.type,
      subject: (row.title ?? "").slice(0, 240),
      firstImageMarker: markers[0] ?? null,
      campaignId: row.campaignId,
      workspaceId: row.workspaceId,
    }).catch((err) => {
      console.warn(
        `[asset-variants] video variant failed for ${contentId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    console.warn(
      `[asset-variants] video kickoff failed for ${contentId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Generate visual assets for a content item via the Art Director pipeline:
 * reads the body + KB → emits a grounded concept brief → produces judged
 * candidates → writes assets rows (winner promoted, runners-up draft). A
 * promotional video is kicked off in parallel.
 */
export async function generateAssetVariants(
  input: GenerateAssetVariantsInput,
): Promise<{ inserted: number }> {
  const { assetPipelineWorkflow } = await import("@/workflows/asset-pipeline");
  // assetPipelineWorkflow is a `"use workflow"` function — the Workflows
  // runtime forbids invoking it directly from non-workflow contexts (API
  // routes, after() callbacks). start() enqueues it as its own run; we
  // await returnValue so callers keep their synchronous semantics.
  const run = await start(assetPipelineWorkflow, [
    {
      workspaceId: input.workspaceId,
      contentId: input.contentId,
      request: input.subject,
    },
  ]);
  // run.returnValue is typed as `unknown` by the workflow SDK overloads; cast
  // to the workflow's declared output now that we passed a concrete input.
  const result = (await run.returnValue) as { candidatesGenerated: number };
  void kickVideoVariant(input.contentId);
  return { inserted: result.candidatesGenerated };
}
