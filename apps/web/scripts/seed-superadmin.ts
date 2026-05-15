// One-off setup for the two-user, single-workspace test fixture.
//
// What it does (idempotent — safe to re-run):
//   1. Ensures auth users exist (creates with email auto-confirmed) for:
//        - admin@marketing.com  (cross-tenant superadmin)
//        - user1@marketing.com  (platform user; owner of the Legacy workspace)
//   2. Ensures the Legacy workspace exists at the canonical fixed UUID and
//      reassigns its owner_user_id to user1.
//   3. Inserts/updates workspace_members so:
//        - user1@marketing.com is the workspace `owner`
//        - admin@marketing.com is workspace `admin` (so the superadmin can
//          also browse the regular workspace UI)
//   4. Inserts admin_users(role='superadmin') for admin@marketing.com only.
//      user1 is intentionally NOT in admin_users — they're a platform user.
//
// Run:
//   pnpm --filter web exec tsx scripts/seed-superadmin.ts
//
// Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL from the
// environment (apps/web/.env.local is auto-loaded via tsx + dotenv).

import path from "node:path";
// dotenv is hoisted from the workspace root; apps/web has no direct dep so
// types aren't visible here. Runtime resolution works via tsx + node_modules.
// @ts-expect-error — see comment above
import dotenv from "dotenv";
// Repo .env lives at the workspace root; apps/web/.env.local is a symlink.
// Resolve relative to this file so the script works from any cwd.
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@marketing/db";
import { PLAN_IDS } from "@marketing/shared-types";

const LEGACY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const LEGACY_WORKSPACE_SLUG = "legacy";
const LEGACY_WORKSPACE_NAME = "Legacy";

const SUPERADMIN_EMAIL = "admin@marketing.com";
const PLATFORM_USER_EMAIL = "user1@marketing.com";

// Dev/test passwords. Login form supports both password and magic-link.
const SUPERADMIN_PASSWORD = "Admin@Marketing123!";
const PLATFORM_USER_PASSWORD = "User1@Marketing123!";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

// Get-or-create. We auto-confirm the email so the user can sign in via magic
// link immediately, AND set a password so the same account can sign in via
// email+password from the login form.
async function ensureAuthUser(
  admin: SupabaseClient,
  email: string,
  password: string,
): Promise<{ id: string; email: string; created: boolean }> {
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listErr) throw listErr;
  const existing = list.users.find(
    (u) => (u.email ?? "").toLowerCase() === email.toLowerCase(),
  );
  if (existing) {
    // Always (re)apply password + confirmation so re-running the seed is the
    // canonical way to reset credentials.
    const { error: updateErr } = await admin.auth.admin.updateUserById(
      existing.id,
      { password, email_confirm: true },
    );
    if (updateErr) throw updateErr;
    return { id: existing.id, email, created: false };
  }
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) throw createErr;
  if (!created.user) throw new Error(`createUser returned no user for ${email}`);
  return { id: created.user.id, email, created: true };
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("→ ensuring auth users (passwords (re)set on every run)…");
  const superadmin = await ensureAuthUser(
    admin,
    SUPERADMIN_EMAIL,
    SUPERADMIN_PASSWORD,
  );
  console.log(
    `  · ${superadmin.email}  ${superadmin.id}  ${superadmin.created ? "(created)" : "(updated)"}`,
  );
  const platformUser = await ensureAuthUser(
    admin,
    PLATFORM_USER_EMAIL,
    PLATFORM_USER_PASSWORD,
  );
  console.log(
    `  · ${platformUser.email}  ${platformUser.id}  ${platformUser.created ? "(created)" : "(updated)"}`,
  );

  const db = createDb(databaseUrl);

  // 1. Ensure Legacy workspace exists; reassign owner to user1.
  const existingWs = await db
    .select({
      id: schema.workspaces.id,
      ownerUserId: schema.workspaces.ownerUserId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, LEGACY_WORKSPACE_ID))
    .limit(1);

  if (existingWs.length === 0) {
    await db.insert(schema.workspaces).values({
      id: LEGACY_WORKSPACE_ID,
      slug: LEGACY_WORKSPACE_SLUG,
      name: LEGACY_WORKSPACE_NAME,
      ownerUserId: platformUser.id,
      planId: PLAN_IDS.enterprise,
      planOverriddenUntil: new Date("2099-01-01T00:00:00Z"),
    });
    console.log(
      `→ created Legacy workspace ${LEGACY_WORKSPACE_ID} owned by ${platformUser.email}`,
    );
  } else {
    if (existingWs[0]!.ownerUserId !== platformUser.id) {
      await db
        .update(schema.workspaces)
        .set({ ownerUserId: platformUser.id, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, LEGACY_WORKSPACE_ID));
      console.log(
        `→ reassigned Legacy workspace owner_user_id → ${platformUser.email}`,
      );
    } else {
      console.log("→ Legacy workspace already owned by user1, skipping");
    }
  }

  // 2. Memberships: user1 = owner, admin = admin.
  for (const { user, role, label } of [
    { user: platformUser, role: "owner" as const, label: "owner" },
    { user: superadmin, role: "admin" as const, label: "admin" },
  ]) {
    const exists = await db
      .select({
        id: schema.workspaceMembers.id,
        role: schema.workspaceMembers.role,
      })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, user.id))
      .limit(1);
    if (exists.length === 0) {
      await db.insert(schema.workspaceMembers).values({
        workspaceId: LEGACY_WORKSPACE_ID,
        userId: user.id,
        role,
        acceptedAt: new Date(),
      });
      console.log(`  · ${user.email} added as ${label}`);
    } else if (exists[0]!.role !== role) {
      await db
        .update(schema.workspaceMembers)
        .set({ role, acceptedAt: new Date() })
        .where(eq(schema.workspaceMembers.id, exists[0]!.id));
      console.log(`  · ${user.email} role updated → ${label}`);
    } else {
      console.log(`  · ${user.email} already ${label}, skipping`);
    }
  }

  // 3. admin_users (superadmin = admin@marketing.com only).
  const adminRow = await db
    .select({ userId: schema.adminUsers.userId })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.userId, superadmin.id))
    .limit(1);
  if (adminRow.length === 0) {
    await db
      .insert(schema.adminUsers)
      .values({ userId: superadmin.id, role: "superadmin" });
    console.log(`  · ${superadmin.email} marked superadmin`);
  } else {
    console.log(`  · ${superadmin.email} already superadmin, skipping`);
  }

  // 4. Ensure user1 is NOT in admin_users (platform user only).
  await db
    .delete(schema.adminUsers)
    .where(eq(schema.adminUsers.userId, platformUser.id));

  console.log("");
  console.log("✓ seed complete.");
  console.log("");
  console.log("Credentials:");
  console.log(`  ${SUPERADMIN_EMAIL}   /  ${SUPERADMIN_PASSWORD}   (superadmin)`);
  console.log(
    `  ${PLATFORM_USER_EMAIL}   /  ${PLATFORM_USER_PASSWORD}   (platform user)`,
  );
  console.log("");
  console.log("Sign in at /login with email + password.");
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ seed failed:", err);
  process.exit(1);
});
