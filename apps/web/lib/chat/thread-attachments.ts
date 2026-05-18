// System-context block listing the user's uploaded chat attachments. The
// orchestrator stitches this into its system prompt every turn so the LLM
// always knows which docs the user has shared in the active conversation.
//
// Attachments live in `chat_attachments` (NOT the KB) — see
// apps/web/lib/chat/chat-attachments.ts for storage and lifecycle. The
// orchestrator can read full bodies via the `attachment_read` tool and
// promote any worth keeping into the KB via `kb_archive_attachment`.

import type { ThreadRef } from "@marketing/shared-types";
import { listActiveByThread } from "./chat-attachments";

// PDF bodies can be hundreds of KB. Inline a head-slice so the LLM has
// immediate context for short uploads, and tell it to call `attachment_read`
// for the full body when the slice is cut.
const INLINE_PREVIEW_CHARS = 4000;

export async function buildThreadAttachmentsContext(opts: {
  workspaceId: string;
  threadRef: ThreadRef;
}): Promise<string | null> {
  const rows = await listActiveByThread({
    workspaceId: opts.workspaceId,
    threadRef: opts.threadRef,
  });
  if (rows.length === 0) return null;

  const sections = rows.map((row) => {
    const truncated = row.bodyMd.length > INLINE_PREVIEW_CHARS;
    const preview = truncated
      ? row.bodyMd.slice(0, INLINE_PREVIEW_CHARS)
      : row.bodyMd;
    const footer = truncated
      ? `\n\n…[truncated — call attachment_read(attachmentId="${row.id}") for the full ${row.bodyMd.length}-char body.]`
      : "";
    return [
      `### "${row.filename}" (${row.mimeType}, attachmentId=${row.id})`,
      preview + footer,
    ].join("\n");
  });

  const count = rows.length;
  return [
    "## Attachments uploaded in this conversation",
    `The user has uploaded ${count} document${count === 1 ? "" : "s"} to this thread. ` +
      `These are TEMPORARY chat context — they are NOT in the Knowledge Base ` +
      `and will not be available in future conversations.`,
    "",
    ...sections,
    "",
    `When the user says "this doc", "the attachment", "this upload", or asks ` +
      `you to use the uploaded material, these are the documents they mean.`,
    `If a doc looks valuable for future use (brand guideline, persona, brief, ` +
      `strategy document), call ` +
      `\`kb_archive_attachment(attachmentId, collectionSlug, title?, description?)\` ` +
      `to promote it into the permanent Knowledge Base before the conversation ends.`,
  ].join("\n");
}
