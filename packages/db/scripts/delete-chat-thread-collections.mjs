#!/usr/bin/env node
// One-shot cleanup: delete the per-thread "chat-thread-<hash>" KB collections
// created by the old chat-uploads-go-into-the-KB flow. Migration 0034 +
// the rewritten apps/web/app/api/chat/attachments/route.ts move new uploads
// into the chat_attachments table; this script clears the legacy KB pile.
//
// USAGE
//   node packages/db/scripts/delete-chat-thread-collections.mjs              # dry-run (default)
//   node packages/db/scripts/delete-chat-thread-collections.mjs --confirm    # actually delete
//
// What it deletes (in order, in a single transaction):
//   1. embeddings   WHERE source_type='kb_chunk' AND source_id IN (chunk ids of these docs)
//   2. kb_collections WHERE slug LIKE 'chat-thread-%'   (FK cascade removes kb_documents + kb_chunks)
//
// DATABASE_URL resolution mirrors migrate.mjs: env / .env / inline override.

import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DATABASE_URL_OVERRIDE = "";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const envFile = join(repoRoot, ".env");
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // older Node — fall through to process.env
  }
}

const databaseUrl = DATABASE_URL_OVERRIDE || process.env.DATABASE_URL || "";
if (!databaseUrl) {
  console.error(
    "✗ DATABASE_URL is not set. Add it to <repo-root>/.env, export it in your shell, or paste it into DATABASE_URL_OVERRIDE.",
  );
  process.exit(1);
}
if (databaseUrl.includes(":6543")) {
  console.error(
    "✗ DATABASE_URL points at the Supabase transaction-mode pooler (port 6543). Use port 5432 (direct OR session-mode pooler) for destructive DDL/DML.",
  );
  process.exit(1);
}

const confirm = process.argv.includes("--confirm");
const sql = postgres(databaseUrl, { prepare: false, max: 1, onnotice: () => {} });

try {
  const collections = await sql`
    SELECT
      c.id            AS collection_id,
      c.slug          AS slug,
      c.name          AS name,
      c.workspace_id  AS workspace_id,
      c.created_at    AS created_at,
      (SELECT count(*) FROM kb_documents d WHERE d.collection_id = c.id) AS doc_count,
      (SELECT count(*) FROM kb_chunks ch JOIN kb_documents d ON ch.document_id = d.id WHERE d.collection_id = c.id) AS chunk_count
    FROM kb_collections c
    WHERE c.slug LIKE 'chat-thread-%'
    ORDER BY c.created_at
  `;

  if (collections.length === 0) {
    console.log("✓ no chat-thread-* collections found — nothing to delete");
    process.exit(0);
  }

  console.log(`Found ${collections.length} legacy chat-thread KB collection${collections.length === 1 ? "" : "s"}:`);
  console.log("");
  let totalDocs = 0;
  let totalChunks = 0;
  for (const c of collections) {
    const docs = Number(c.doc_count);
    const chunks = Number(c.chunk_count);
    totalDocs += docs;
    totalChunks += chunks;
    console.log(
      `  ${c.slug.padEnd(28)}  ws=${String(c.workspace_id).slice(0, 8)}  docs=${String(docs).padStart(3)}  chunks=${String(chunks).padStart(4)}  ${new Date(c.created_at).toISOString().slice(0, 10)}  "${c.name}"`,
    );
  }
  console.log("");
  console.log(`Total: ${collections.length} collections, ${totalDocs} documents, ${totalChunks} chunks (+ embeddings).`);

  if (!confirm) {
    console.log("");
    console.log("(dry-run — pass --confirm to actually delete)");
    process.exit(0);
  }

  console.log("");
  console.log("→ deleting…");

  const result = await sql.begin(async (tx) => {
    // Embeddings have no FK to kb_chunks (see store.ts:deleteChunksFor) so we
    // wipe them manually before the cascade removes the chunk rows.
    const collectionIds = collections.map((c) => c.collection_id);
    const embedded = await tx`
      DELETE FROM embeddings
      WHERE source_type = 'kb_chunk'
        AND source_id IN (
          SELECT ch.id::text
          FROM kb_chunks ch
          JOIN kb_documents d ON ch.document_id = d.id
          WHERE d.collection_id = ANY(${collectionIds}::uuid[])
        )
      RETURNING 1
    `;
    const removed = await tx`
      DELETE FROM kb_collections
      WHERE id = ANY(${collectionIds}::uuid[])
      RETURNING id
    `;
    return { embeddings: embedded.count, collections: removed.count };
  });

  console.log(
    `✓ deleted ${result.collections} collections (cascade removed ${totalDocs} docs + ${totalChunks} chunks) and ${result.embeddings} embedding rows.`,
  );
} finally {
  await sql.end();
}
