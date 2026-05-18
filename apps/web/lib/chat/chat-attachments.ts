// Drizzle CRUD for chat_attachments — the per-thread temporary upload store.
// Replaces the old per-thread KB collection (apps/web/lib/chat/thread-attachments.ts)
// so user uploads stop polluting the workspace KB.
//
// Lifecycle:
//   - POST /api/chat/attachments      → createChatAttachment
//   - GET  /api/chat/attachments      → listActiveByThread
//   - DELETE /api/chat/attachments    → dismissChatAttachment (soft-delete)
//   - orchestrator buildChatSystemContext → listActiveByThread (inlines bodies)
//   - kb_archive_attachment tool      → markArchived (after creating the KB doc)

import { and, eq, isNull } from "drizzle-orm";
import {
  chatAttachments,
  getDb,
  type ChatAttachment,
  type NewChatAttachment,
} from "@marketing/db";

export type CreateChatAttachmentInput = Omit<
  NewChatAttachment,
  "id" | "createdAt" | "archivedKbDocId" | "dismissedAt"
>;

export async function createChatAttachment(
  input: CreateChatAttachmentInput,
): Promise<ChatAttachment> {
  const db = getDb();
  const [row] = await db.insert(chatAttachments).values(input).returning();
  if (!row) throw new Error("chat_attachments insert returned no rows");
  return row;
}

/**
 * Returns every live attachment for this thread — i.e. not dismissed by the
 * user and not yet archived into the KB. Ordered oldest-first so the
 * orchestrator's system context lists them in upload order.
 */
export async function listActiveByThread(opts: {
  workspaceId: string;
  threadRef: string;
}): Promise<ChatAttachment[]> {
  const db = getDb();
  return db
    .select()
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.workspaceId, opts.workspaceId),
        eq(chatAttachments.threadRef, opts.threadRef),
        isNull(chatAttachments.dismissedAt),
        isNull(chatAttachments.archivedKbDocId),
      ),
    )
    .orderBy(chatAttachments.createdAt);
}

export async function getChatAttachment(opts: {
  workspaceId: string;
  id: string;
}): Promise<ChatAttachment | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.workspaceId, opts.workspaceId),
        eq(chatAttachments.id, opts.id),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Soft-delete: user clicked × on a pill. Pill disappears, body stays. */
export async function dismissChatAttachment(opts: {
  workspaceId: string;
  id: string;
}): Promise<void> {
  const db = getDb();
  await db
    .update(chatAttachments)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(chatAttachments.workspaceId, opts.workspaceId),
        eq(chatAttachments.id, opts.id),
      ),
    );
}

/** Called by kb_archive_attachment after the KB doc is created. */
export async function markArchived(opts: {
  workspaceId: string;
  id: string;
  kbDocumentId: string;
}): Promise<void> {
  const db = getDb();
  await db
    .update(chatAttachments)
    .set({ archivedKbDocId: opts.kbDocumentId })
    .where(
      and(
        eq(chatAttachments.workspaceId, opts.workspaceId),
        eq(chatAttachments.id, opts.id),
      ),
    );
}
