/**
 * Embedding pipeline entrypoints. Phase 4 cutover: the Distributor HTTP
 * fallback is gone. Both calls always start the matching Vercel Workflow.
 *
 * Failures are wrapped so the caller (typically /api/approvals) doesn't
 * block on a transient embed-pipeline error.
 */

export async function enqueueEmbedding(contentId: string): Promise<void> {
  const { start } = await import("workflow/api");
  const { embedContentWorkflow } = await import("@/workflows/embed");
  await start(embedContentWorkflow, [{ contentId }]);
}

/**
 * Enqueue an embedding job for a rejected / changes_requested agent_feedback row
 * so the Content sub-agent's findCommonMistakes tool can later surface it.
 */
export async function enqueueRejectedDraftEmbedding(
  feedbackId: string,
): Promise<void> {
  const { start } = await import("workflow/api");
  const { embedRejectedDraftWorkflow } = await import("@/workflows/embed");
  await start(embedRejectedDraftWorkflow, [{ feedbackId }]);
}
