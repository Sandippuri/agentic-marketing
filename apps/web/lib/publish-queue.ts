import type { Channel } from "@marketing/shared-types";

// Publish dispatch. Phase 4 cutover: the BullMQ + Redis path is gone — every
// call goes through the publishWorkflow on Vercel. The publish_jobs DB row
// remains the source of truth; the workflow updates it through the same
// steps that used to run inside the Distributor.

export type PublishJobMessage = {
  publishJobId: string;
  contentId: string;
  workspaceId: string;
  channel: Channel;
  threadRef?: string;
  mode?: "live" | "test";
};

export async function enqueuePublish(
  msg: PublishJobMessage,
  opts?: { delayMs?: number },
): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    const { start } = await import("workflow/api");
    const { publishWorkflow } = await import("@/workflows/publish");
    await start(publishWorkflow, [
      {
        publishJobId: msg.publishJobId,
        contentId: msg.contentId,
        workspaceId: msg.workspaceId,
        channel: msg.channel,
        threadRef: msg.threadRef,
        mode: msg.mode,
        delaySeconds:
          opts?.delayMs && opts.delayMs > 0
            ? Math.round(opts.delayMs / 1000)
            : undefined,
      },
    ]);
    return { enqueued: true };
  } catch (err) {
    return {
      enqueued: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
