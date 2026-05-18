-- Migration 0034: chat_attachments.
--
-- Replaces the per-thread "chat-thread-<hash>" KB collection that every chat
-- upload used to land in. Those uploads are temporary context for the active
-- conversation, NOT permanent reference material — the assistant decides what
-- to promote into the KB via the new kb_archive_attachment tool.
--
-- Pre-existing per-thread KB collections are cleaned up by
--   packages/db/scripts/delete-chat-thread-collections.mjs
-- which runs as a one-shot after this migration ships.

CREATE TABLE IF NOT EXISTS "chat_attachments" (
  "id"                  uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"        uuid                     NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "thread_ref"          text                     NOT NULL,
  "filename"            text                     NOT NULL,
  "mime_type"           text                     NOT NULL,
  "size_bytes"          integer                  NOT NULL,
  "storage_path"        text                     NOT NULL,
  "body_md"             text                     NOT NULL DEFAULT '',
  "archived_kb_doc_id"  uuid                     REFERENCES "kb_documents"("id") ON DELETE SET NULL,
  "dismissed_at"        timestamp with time zone,
  "created_by"          uuid,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "chat_attachments_thread_idx"
  ON "chat_attachments" ("workspace_id", "thread_ref")
  WHERE "dismissed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "chat_attachments_workspace_idx"
  ON "chat_attachments" ("workspace_id");

--> statement-breakpoint

ALTER TABLE "chat_attachments" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_read_chat_attachments" ON "chat_attachments";
CREATE POLICY "team_read_chat_attachments" ON "chat_attachments"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "team_write_chat_attachments" ON "chat_attachments";
CREATE POLICY "team_write_chat_attachments" ON "chat_attachments"
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
