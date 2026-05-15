// One-time bootstrap for the SaaS migration (PR 2). Idempotent — safe to
// re-run.
//
// What it does:
//   1. Resolves every email on AUTH_ALLOWLIST to its auth.users.id via the
//      Supabase service-role admin API.
//   2. Creates the canonical "Legacy" workspace if it doesn't exist (fixed
//      uuid 00000000-0000-0000-0000-000000000001 — PR 3's backfill migration
//      assigns every existing tenant row to this workspace).
//   3. Adds each resolved user as an `admin` member of the Legacy workspace.
//   4. Adds each resolved user to `admin_users` with role `superadmin` so
//      they can reach /super/* before the role table has any other entries.
//
// Run:
//   DATABASE_URL=...                                                       \
//   SUPABASE_URL=...                                                       \
//   SUPABASE_SERVICE_ROLE_KEY=...                                          \
//   AUTH_ALLOWLIST="alice@team.io,bob@team.io,venture23.io"                \
//   pnpm --filter web exec tsx scripts/bootstrap-saas.ts
//
// Domain-style allowlist entries (e.g. "venture23.io") match every existing
// auth.users row at that domain. Exact-email entries match that one user.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@marketing/db";
import { PLAN_IDS } from "@marketing/shared-types";

const LEGACY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const LEGACY_WORKSPACE_SLUG = "legacy";
const LEGACY_WORKSPACE_NAME = "Legacy";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

type ResolvedUser = { id: string; email: string };

// SupabaseClient generics drift between releases; the script is a one-off
// admin tool, not library code, so we accept the loose type rather than
// trying to thread the right type parameters here.
type Admin = { auth: { admin: { listUsers: (opts: { page: number; perPage: number }) => Promise<{ data: { users: { id: string; email: string | null }[] }; error: { message: string } | null }> } } };

async function listAllAuthUsers(admin: Admin): Promise<ResolvedUser[]> {
  const out: ResolvedUser[] = [];
  let page = 1;
  // Supabase caps at 1000 per page; we'll never have more than a few
  // hundred in private beta, but loop for correctness.
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    for (const u of data.users) {
      if (u.email) out.push({ id: u.id, email: u.email });
    }
    if (data.users.length < 1000) break;
    page += 1;
  }
  return out;
}

function matchesAllowlist(email: string, entries: string[]): boolean {
  const lower = email.toLowerCase();
  for (const entry of entries) {
    if (entry.includes("@")) {
      if (entry === lower) return true;
    } else if (lower.endsWith(`@${entry}`)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const allowlist = (process.env.AUTH_ALLOWLIST ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) {
    throw new Error(
      "AUTH_ALLOWLIST is empty; nothing to bootstrap. Set it to the comma-separated allowlist used in production.",
    );
  }

  const admin = createClient(supabaseUrl, serviceKey) as unknown as Admin;
  console.log("→ listing auth.users…");
  const allUsers = await listAllAuthUsers(admin);
  const matched = allUsers.filter((u) => matchesAllowlist(u.email, allowlist));
  if (matched.length === 0) {
    throw new Error(
      `no auth.users matched AUTH_ALLOWLIST. found ${allUsers.length} total users.`,
    );
  }
  console.log(`→ ${matched.length}/${allUsers.length} users matched allowlist`);

  const db = createDb(databaseUrl);
  const owner = matched[0]!; // first matched user is the Legacy workspace owner

  // 1. Ensure Legacy workspace exists.
  const existing = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, LEGACY_WORKSPACE_ID))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(schema.workspaces).values({
      id: LEGACY_WORKSPACE_ID,
      slug: LEGACY_WORKSPACE_SLUG,
      name: LEGACY_WORKSPACE_NAME,
      ownerUserId: owner.id,
      planId: PLAN_IDS.enterprise,
      // Pin to Enterprise far enough out that we can't accidentally bill it.
      planOverriddenUntil: new Date("2099-01-01T00:00:00Z"),
    });
    console.log(
      `→ created Legacy workspace ${LEGACY_WORKSPACE_ID} owned by ${owner.email}`,
    );
  } else {
    console.log(`→ Legacy workspace already exists, skipping create`);
  }

  // 2. Add members. The owner gets role=owner; everyone else admin.
  for (const u of matched) {
    const exists = await db
      .select({ id: schema.workspaceMembers.id })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, u.id))
      .limit(1);
    if (exists.length > 0) {
      console.log(`  · ${u.email} already a member, skipping`);
      continue;
    }
    await db.insert(schema.workspaceMembers).values({
      workspaceId: LEGACY_WORKSPACE_ID,
      userId: u.id,
      role: u.id === owner.id ? "owner" : "admin",
      acceptedAt: new Date(),
    });
    console.log(`  · ${u.email} added as ${u.id === owner.id ? "owner" : "admin"}`);
  }

  // 3. admin_users (superadmin role for every bootstrapped user).
  for (const u of matched) {
    const exists = await db
      .select({ userId: schema.adminUsers.userId })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, u.id))
      .limit(1);
    if (exists.length > 0) {
      console.log(`  · ${u.email} already superadmin, skipping`);
      continue;
    }
    await db.insert(schema.adminUsers).values({
      userId: u.id,
      role: "superadmin",
    });
    console.log(`  · ${u.email} marked superadmin`);
  }

  console.log("✓ bootstrap complete");
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ bootstrap failed:", err);
  process.exit(1);
});
