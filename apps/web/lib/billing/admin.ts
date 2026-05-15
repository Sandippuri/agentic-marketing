// Superadmin / operator gate. Backed by the admin_users table created in
// migration 0024. AUTH_ALLOWLIST stays in place for sign-up gating during
// private beta and is separate from cross-tenant operator authority.

import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import type { AdminRole } from "@marketing/shared-types";
import { getSupabaseServer } from "../supabase/server";
import { SuperadminRequiredError } from "./errors";
import { UnauthorizedError } from "../auth";

export type AdminContext = {
  userId: string;
  email: string | null;
  role: AdminRole;
};

export async function lookupAdminRole(
  userId: string,
): Promise<AdminRole | null> {
  const db = getDb();
  const rows = await db
    .select({ role: schema.adminUsers.role })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.userId, userId))
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function isSuperadmin(userId: string): Promise<boolean> {
  const role = await lookupAdminRole(userId);
  return role === "superadmin";
}

// Use at the top of every /super/* route handler and server page.
// Throws UnauthorizedError if there is no session, SuperadminRequiredError
// if the session user isn't in admin_users.
export async function requireSuperadmin(): Promise<AdminContext> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) throw new UnauthorizedError();
  const role = await lookupAdminRole(data.user.id);
  if (role !== "superadmin") throw new SuperadminRequiredError();
  return { userId: data.user.id, email: data.user.email ?? null, role };
}
