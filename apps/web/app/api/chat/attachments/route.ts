// Chat attachments — temporary per-thread uploads (NOT in the KB).
//
// POST   /api/chat/attachments         → upload one or more files
// GET    /api/chat/attachments?threadRef=…    → list live attachments
// DELETE /api/chat/attachments?id=…    → soft-delete (user dismissed the pill)
//
// Files land in `chat_attachments`, not in a per-thread KB collection. The
// assistant decides which uploads are worth promoting to the KB via the
// `kb_archive_attachment` tool. Without that explicit step, an upload is
// scoped to the active conversation only.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BRAND_DOC_MIME_TYPES, type ThreadRef } from "@marketing/shared-types";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { brandDocStoragePath, uploadBrandDoc } from "@/lib/supabase/storage";
import { getWorkspaceContext } from "@/lib/billing";
import { extractAttachmentText } from "@/lib/chat/extract-attachment-text";
import {
  createChatAttachment,
  dismissChatAttachment,
  getChatAttachment,
  listActiveByThread,
} from "@/lib/chat/chat-attachments";

export const dynamic = "force-dynamic";
// PDF extraction goes through Haiku; budget generous timeout for big PDFs.
export const maxDuration = 300;

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 5;

const SUPPORTED_MIMES = new Set<string>(
  BRAND_DOC_MIME_TYPES.filter(
    (m) =>
      m !==
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ),
);

const ThreadRefSchema = z.string().min(3).max(200);
const AttachmentIdSchema = z.string().uuid();

type AttachmentDTO = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
};

function toDto(row: {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}): AttachmentDTO {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.createdAt.toISOString(),
  };
}

export async function POST(request: Request) {
  try {
    const actor = await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();

    const form = await request.formData();

    const threadRef = ThreadRefSchema.parse(
      form.get("threadRef")?.toString() ?? "",
    ) as ThreadRef;

    const files = form
      .getAll("file")
      .filter((v): v is File => v instanceof File);

    if (files.length === 0) {
      return Response.json({ error: "no_files" }, { status: 400 });
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return Response.json(
        { error: "too_many_files", limit: MAX_FILES_PER_REQUEST },
        { status: 400 },
      );
    }

    const attachments: AttachmentDTO[] = [];

    for (const file of files) {
      if (file.size === 0) {
        return Response.json(
          { error: "empty_file", filename: file.name },
          { status: 400 },
        );
      }
      if (file.size > MAX_BYTES) {
        return Response.json(
          { error: "file_too_large", filename: file.name, limit: MAX_BYTES },
          { status: 400 },
        );
      }

      const mimeType = file.type || "application/octet-stream";
      if (!SUPPORTED_MIMES.has(mimeType)) {
        return Response.json(
          {
            error: "unsupported_mime",
            filename: file.name,
            mimeType,
            supported: Array.from(SUPPORTED_MIMES),
            hint:
              mimeType ===
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                ? "DOCX is not supported yet. Export to PDF or paste as Markdown."
                : undefined,
          },
          { status: 400 },
        );
      }

      const uploadId = randomUUID();
      const storagePath = brandDocStoragePath(uploadId, file.name);
      const buffer = Buffer.from(await file.arrayBuffer());
      await uploadBrandDoc(storagePath, buffer, mimeType);

      const bodyMd = await extractAttachmentText({
        buffer,
        mimeType,
        filename: file.name,
        workspaceId,
      });

      if (!bodyMd) {
        return Response.json(
          {
            error: "empty_extraction",
            filename: file.name,
            message:
              "Could not extract text from this file (scanned PDF, image-only PDF, or empty).",
          },
          { status: 400 },
        );
      }

      const row = await createChatAttachment({
        workspaceId,
        threadRef,
        filename: file.name,
        mimeType,
        sizeBytes: file.size,
        storagePath,
        bodyMd,
        createdBy: actor.id ?? null,
      });

      attachments.push(toDto(row));
    }

    return Response.json({ attachments }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const url = new URL(request.url);
    const threadRef = ThreadRefSchema.parse(
      url.searchParams.get("threadRef") ?? "",
    ) as ThreadRef;

    const rows = await listActiveByThread({ workspaceId, threadRef });
    return Response.json({ attachments: rows.map(toDto) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const url = new URL(request.url);
    const id = AttachmentIdSchema.parse(url.searchParams.get("id") ?? "");

    const existing = await getChatAttachment({ workspaceId, id });
    if (!existing) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    await dismissChatAttachment({ workspaceId, id });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
