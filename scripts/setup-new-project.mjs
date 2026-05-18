#!/usr/bin/env node
// =============================================================================
// One-shot bootstrap for a fresh Supabase project.
//
//   1. Paste your NEW Supabase project credentials into the CONFIG block below.
//   2. Run:  node scripts/setup-new-project.mjs
//
// What this does (in order):
//   1. Runs migrate.mjs against DATABASE_URL — applies every numbered
//      migration in packages/db/drizzle/ and records them in
//      _schema_migrations.
//   2. Applies infra/supabase/{policies,views,seed}.sql — RLS, analytics
//      views, and default settings rows.
//   3. Runs seed-superadmin.ts — creates 3 dev users via Supabase Auth and
//      wires them into the Legacy workspace:
//        admin@marketing.com    Admin@Marketing123!    (superadmin)
//        user1@marketing.com    User1@Marketing123!    (Legacy owner)
//        user2@marketing.com    User2@Marketing123!    (own workspace on first sign-in)
//
// ⚠ DO NOT COMMIT THIS FILE AFTER FILLING IN CREDENTIALS.
//   Either keep the constants empty (the script falls back to environment
//   variables) or git-ignore this file locally with:
//     echo "scripts/setup-new-project.mjs" >> .git/info/exclude
// =============================================================================

// ============================================================
//  ✏  PASTE YOUR NEW SUPABASE PROJECT CREDENTIALS HERE
// ============================================================

// DIRECT connection URL — Supabase dashboard → Project Settings → Database →
// Connection string → "Direct connection" (port 5432). NOT the pooler (6543).
// Example: "postgresql://postgres:YOUR_PW@db.YOUR_REF.supabase.co:5432/postgres"
const DATABASE_URL =
  "postgresql://postgres.zjvgldhqbgbsybhpretv:Test@Sandip8@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true";

// Project URL — dashboard → Project Settings → API → "Project URL".
// Example: "https://YOUR_REF.supabase.co"
const SUPABASE_URL = "https://zjvgldhqbgbsybhpretv.supabase.co";

// Service role key — dashboard → Project Settings → API → "service_role" (NOT anon).
// Keep secret; this key bypasses RLS.
const SUPABASE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpqdmdsZGhxYmdic3liaHByZXR2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODkwNDAyMywiZXhwIjoyMDk0NDgwMDIzfQ.pAY1G3vhVz-4Xk8jW1vulhuW2JnprDT_WLzj5EFY3oE";

// ============================================================
//  Nothing below should need editing.
// ============================================================

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function pick(name, configValue) {
  // Inline config wins; fall back to environment variable.
  if (configValue && configValue.length > 0) return configValue;
  return process.env[name] ?? "";
}

const env = {
  ...process.env,
  DATABASE_URL: pick("DATABASE_URL", DATABASE_URL),
  SUPABASE_URL: pick("SUPABASE_URL", SUPABASE_URL),
  SUPABASE_SERVICE_ROLE_KEY: pick(
    "SUPABASE_SERVICE_ROLE_KEY",
    SUPABASE_SERVICE_ROLE_KEY,
  ),
};

const missing = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
].filter((k) => !env[k]);
if (missing.length > 0) {
  console.error(`✗ missing: ${missing.join(", ")}`);
  console.error("");
  console.error("Either paste them into the CONFIG block at the top of");
  console.error(`   ${fileURLToPath(import.meta.url)}`);
  console.error("or export them in your shell before running this script.");
  process.exit(1);
}

if (!env.DATABASE_URL.includes(":5432")) {
  const masked = env.DATABASE_URL.replace(/:[^:@/]+@/, ":<password>@");
  console.warn(
    "⚠ DATABASE_URL does not use port 5432 — looks like the pooler.",
  );
  console.warn(`   ${masked}`);
  console.warn("   Bootstrap DDL via pgbouncer (port 6543) often hangs.");
  console.warn("   Swap to the DIRECT connection URL and try again.");
  console.warn("   Continuing in 5s. Ctrl+C to abort.");
  await new Promise((r) => setTimeout(r, 5000));
}

function run(label, cmd, args) {
  console.log(`\n→ ${label}`);
  const r = spawnSync(cmd, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✗ "${label}" failed (exit ${r.status ?? "signal"})`);
    process.exit(r.status ?? 1);
  }
}

run("1/5 apply numbered migrations (schema)", "node", [
  "packages/db/scripts/migrate.mjs",
  "run",
]);

const applyInfra = (file) => [
  "--filter",
  "@marketing/db",
  "exec",
  "tsx",
  "scripts/apply-sql.ts",
  `../../infra/supabase/${file}`,
];

run("2/5 apply infra/supabase/policies.sql (RLS)", "pnpm", applyInfra("policies.sql"));
run("3/5 apply infra/supabase/views.sql (analytics views)", "pnpm", applyInfra("views.sql"));
run("4/5 apply infra/supabase/seed.sql (default settings rows)", "pnpm", applyInfra("seed.sql"));

run("5/5 seed 3 dev users + Legacy workspace memberships", "pnpm", [
  "--filter",
  "web",
  "exec",
  "tsx",
  "scripts/seed-superadmin.ts",
]);

console.log("");
console.log("✓ bootstrap complete. Sign in at /login with:");
console.log("    admin@marketing.com    Admin@Marketing123!     (superadmin)");
console.log(
  "    user1@marketing.com    User1@Marketing123!     (Legacy owner)",
);
console.log(
  "    user2@marketing.com    User2@Marketing123!     (own workspace)",
);
