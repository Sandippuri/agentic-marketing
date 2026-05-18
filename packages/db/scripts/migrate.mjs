#!/usr/bin/env node
// Incremental migration runner for packages/db/drizzle/*.sql.
//
// One command, two scenarios:
//   - Fresh empty DB → applies every migration in order (0000 → latest).
//   - Existing DB    → applies only files not yet in `_schema_migrations`.
//
// USAGE
//   pnpm db:migrate:run            # apply every pending migration in order
//   pnpm db:migrate:list           # show applied vs. pending (no DB writes)
//   pnpm db:migrate:run --dry-run  # print the plan without executing
//
// DATABASE_URL resolution (first match wins):
//   1. DATABASE_URL_OVERRIDE constant below (do NOT commit a real URL here)
//   2. process.env.DATABASE_URL
//   3. DATABASE_URL inside <repo-root>/.env (auto-loaded if present)
//
// Each migration runs in its own transaction. On failure nothing is recorded —
// fix the SQL and re-run. Requires the DIRECT Supabase URL (port 5432); DDL
// through the pgbouncer pooler (6543) can hang and is rejected up-front.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DATABASE_URL_OVERRIDE = "";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = resolve(here, "..");
const repoRoot = resolve(dbRoot, "..", "..");
const migrationsDir = join(dbRoot, "drizzle");

const envFile = join(repoRoot, ".env");
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // older Node, or unreadable file — fall through to process.env only
  }
}

const databaseUrl = DATABASE_URL_OVERRIDE || process.env.DATABASE_URL || "";
if (!databaseUrl) {
  console.error(
    "✗ DATABASE_URL is not set. Options:\n" +
      "  1. Add DATABASE_URL=... to <repo-root>/.env\n" +
      "  2. export DATABASE_URL=... in your shell\n" +
      "  3. Paste it into DATABASE_URL_OVERRIDE at the top of this script\n" +
      "Use the DIRECT connection (port 5432), not the pgbouncer pooler (6543).",
  );
  process.exit(1);
}

if (databaseUrl.includes(":6543")) {
  console.error(
    "✗ DATABASE_URL points at the Supabase transaction-mode pooler (port 6543).\n" +
      "  DDL through transaction-mode pooling can hang indefinitely.\n" +
      "  Use port 5432 (direct OR session-mode pooler) for migrations.\n" +
      "  After this runs, you can switch back to :6543 for app traffic.",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--")) ?? "run";
const dryRun = args.includes("--dry-run");
if (!["run", "list"].includes(mode)) {
  console.error(`✗ unknown mode: ${mode}. Expected: run | list.`);
  process.exit(1);
}

const allMigrations = readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

if (allMigrations.length === 0) {
  console.error("✗ no migration files found in", migrationsDir);
  process.exit(1);
}

const sql = postgres(databaseUrl, { prepare: false, max: 1, onnotice: () => {} });

try {
  await sql`
    CREATE TABLE IF NOT EXISTS "_schema_migrations" (
      "filename"    text PRIMARY KEY,
      "applied_at"  timestamptz NOT NULL DEFAULT now(),
      "applied_by"  text         NOT NULL DEFAULT current_user
    )
  `;

  const appliedRows = await sql`SELECT filename FROM _schema_migrations`;
  const applied = new Set(appliedRows.map((r) => r.filename));
  const pending = allMigrations.filter((f) => !applied.has(f));

  if (mode === "list") {
    console.log(`applied: ${applied.size}    pending: ${pending.length}`);
    for (const f of allMigrations) {
      console.log(`  ${applied.has(f) ? "✓" : "·"} ${f}`);
    }
    process.exit(0);
  }

  // mode === "run"
  if (pending.length === 0) {
    console.log("✓ database is up to date — no pending migrations");
    process.exit(0);
  }

  console.log(`→ ${pending.length} pending migration${pending.length === 1 ? "" : "s"}:`);
  for (const f of pending) console.log(`  · ${f}`);

  if (dryRun) {
    console.log("(dry-run — nothing applied)");
    process.exit(0);
  }

  for (const filename of pending) {
    const body = readFileSync(join(migrationsDir, filename), "utf8");
    process.stdout.write(`  applying ${filename}… `);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _schema_migrations (filename) VALUES (${filename})`;
      });
      console.log("✓");
    } catch (err) {
      console.log("✗");
      console.error(`\n✗ ${filename} failed — nothing was recorded for this file.`);
      console.error(err);
      process.exit(1);
    }
  }

  console.log(`✓ applied ${pending.length} migration${pending.length === 1 ? "" : "s"}`);
} finally {
  await sql.end();
}
