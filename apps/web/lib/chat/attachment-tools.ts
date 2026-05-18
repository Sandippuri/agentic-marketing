// Chat orchestrator tools for the temporary-attachment lifecycle.
//
//   attachment_read       — fetch the full body of a chat upload by id
//   kb_archive_attachment — promote a chat upload into a real KB document so
//                           it survives the conversation
//
// Both are scoped to the orchestrator's caller workspace. Sub-agents do not
// see these tools — they're chat-orchestrator-only because the `chat_attachments`
// table is a chat-only concept.

import { tool } from "ai";
import { z } from "zod";
import {
  chunkAndEmbed,
  ensureCollection,
  upsertDocument,
  type CollectionKind,
} from "@marketing/agents/kb";
import {
  getChatAttachment,
  markArchived,
} from "./chat-attachments";

const DEFAULT_ARCHIVE_COLLECTION_SLUG = "chat-archive";
const DEFAULT_ARCHIVE_COLLECTION_NAME = "Chat archive";
// External-doc keeps it adjacent to other user-uploaded reference material
// (briefs, brand decks) rather than burying it under playbook / SOP.
const ARCHIVE_COLLECTION_KIND: CollectionKind = "external_doc";

export function buildAttachmentTools({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}) {
  return {
    attachment_read: tool({
      description:
        "Read the full markdown body of a chat attachment the user uploaded " +
        "earlier in this conversation. Use the `attachmentId` shown in the " +
        "system context. Use this when the preview in the system context was " +
        "truncated, or when you need to quote a specific passage verbatim.",
      parameters: z.object({
        attachmentId: z.string().uuid(),
      }),
      execute: async ({ attachmentId }) => {
        const row = await getChatAttachment({ workspaceId, id: attachmentId });
        if (!row) return { error: "not_found", attachmentId };
        if (row.dismissedAt) {
          return {
            error: "dismissed",
            attachmentId,
            message:
              "The user dismissed this attachment. Do not reference it further.",
          };
        }
        return {
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          uploadedAt: row.createdAt.toISOString(),
          bodyMd: row.bodyMd,
        };
      },
    }),

    kb_archive_attachment: tool({
      description:
        "Promote a chat attachment into the permanent Knowledge Base so " +
        "future conversations and sub-agents can retrieve it via kb_search. " +
        "Use ONLY when the uploaded doc is genuinely durable reference " +
        "material (brand guideline, persona, ICP, competitor profile, " +
        "campaign brief, strategy memo, SOP). Do NOT archive transient " +
        "context (a one-off question, a draft the user is iterating on, a " +
        "screenshot of an error). The KB doc is created in an external_doc " +
        "collection (default slug 'chat-archive'); pass `collectionSlug` to " +
        "target an existing collection instead. Idempotent: re-archiving the " +
        "same attachment returns the existing KB document.",
      parameters: z.object({
        attachmentId: z.string().uuid(),
        collectionSlug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .optional()
          .describe(
            "Target KB collection slug. Defaults to 'chat-archive'. Pass an " +
              "existing slug to file the doc under a specific collection.",
          ),
        title: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Human title for the KB doc. Defaults to the original filename.",
          ),
        description: z
          .string()
          .max(1000)
          .optional()
          .describe(
            "Why this is worth keeping. Stored in metadata; shown to admins " +
              "browsing the KB.",
          ),
      }),
      execute: async ({ attachmentId, collectionSlug, title, description }) => {
        const row = await getChatAttachment({ workspaceId, id: attachmentId });
        if (!row) return { error: "not_found", attachmentId };
        if (row.archivedKbDocId) {
          return {
            kbDocumentId: row.archivedKbDocId,
            collectionSlug: collectionSlug ?? DEFAULT_ARCHIVE_COLLECTION_SLUG,
            status: "already_archived",
          };
        }
        if (row.dismissedAt) {
          return {
            error: "dismissed",
            attachmentId,
            message: "User dismissed this attachment; refuse to archive.",
          };
        }

        const slug = collectionSlug ?? DEFAULT_ARCHIVE_COLLECTION_SLUG;
        const collectionId = await ensureCollection({
          workspaceId,
          slug,
          name:
            slug === DEFAULT_ARCHIVE_COLLECTION_SLUG
              ? DEFAULT_ARCHIVE_COLLECTION_NAME
              : slug,
          kind: ARCHIVE_COLLECTION_KIND,
          scope: "global",
          campaignId: null,
        });

        const doc = await upsertDocument({
          workspaceId,
          collectionId,
          slug: `att-${attachmentId}`,
          title: title ?? row.filename,
          source: "upload",
          sourceRef: row.storagePath,
          bodyMd: row.bodyMd,
          metadata: {
            originalFilename: row.filename,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            storagePath: row.storagePath,
            archivedFromChat: true,
            chatThreadRef: row.threadRef,
            chatAttachmentId: row.id,
            archivedBy: userId,
            archivedAt: new Date().toISOString(),
            ...(description ? { description } : {}),
          },
          status: "active",
          createdBy: userId,
        });

        const ingest = await chunkAndEmbed(doc.id).catch((err) => ({
          error: (err as Error).message,
          embedded: 0,
        }));

        await markArchived({
          workspaceId,
          id: attachmentId,
          kbDocumentId: doc.id,
        });

        return {
          kbDocumentId: doc.id,
          collectionSlug: slug,
          chunks: "embedded" in ingest ? ingest.embedded : 0,
          status: "archived",
        };
      },
    }),
  };
}
