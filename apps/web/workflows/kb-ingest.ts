/**
 * kb-ingest workflow — chunk + embed a Knowledge Base document.
 *
 * Triggered by the /api/kb/documents POST/PATCH routes when a body changes
 * (or by the seed script for bulk imports). Uses the same chunking +
 * embedding pipeline that the route handlers can call synchronously, but
 * wrapped in a Vercel Workflow so:
 *   - large bodies don't block the request,
 *   - retries are durable on transient OpenAI failures,
 *   - workflow_runs gets a row for observability.
 */
import { chunkAndEmbed } from "@marketing/agents/kb";

export type KbIngestInput = {
  documentId: string;
};

export type KbIngestResult = {
  chunks: number;
  embedded: number;
};

export async function kbIngestWorkflow(
  input: KbIngestInput,
): Promise<KbIngestResult> {
  "use workflow";
  return await ingestStep(input);
}

async function ingestStep(input: KbIngestInput): Promise<KbIngestResult> {
  "use step";
  return await chunkAndEmbed(input.documentId);
}
