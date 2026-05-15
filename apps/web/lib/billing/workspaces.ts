// Workspace provisioning & lookup helpers. Used by the auth callback to
// bootstrap a personal workspace on first login, and by the workspace-context
// resolver to enumerate a user's memberships.
//
// Idempotent by design: every call is safe to retry on the same user.

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { PLAN_IDS, type WorkspaceRole } from "@marketing/shared-types";
import { getPlanByCode } from "./plans";

export type WorkspaceMembership = {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  role: WorkspaceRole;
  planId: string;
  isOwner: boolean;
};

export async function listMembershipsForUser(
  userId: string,
): Promise<WorkspaceMembership[]> {
  const db = getDb();
  const rows = await db
    .select({
      workspaceId: schema.workspaces.id,
      workspaceSlug: schema.workspaces.slug,
      workspaceName: schema.workspaces.name,
      role: schema.workspaceMembers.role,
      planId: schema.workspaces.planId,
      ownerUserId: schema.workspaces.ownerUserId,
      deletedAt: schema.workspaces.deletedAt,
    })
    .from(schema.workspaceMembers)
    .innerJoin(
      schema.workspaces,
      eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
    )
    .where(eq(schema.workspaceMembers.userId, userId));

  return rows
    .filter((r) => r.deletedAt === null)
    .map((r) => ({
      workspaceId: r.workspaceId,
      workspaceSlug: r.workspaceSlug,
      workspaceName: r.workspaceName,
      role: r.role,
      planId: r.planId,
      isOwner: r.ownerUserId === userId,
    }));
}

// Build a slug from an email's local-part. Stable, lowercased, alphanumeric.
// Collisions are resolved by appending `-<n>` until unique.
function emailToSlugBase(email: string): string {
  const local = email.split("@")[0] ?? "user";
  const cleaned = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "user";
}

async function findFreeSlug(base: string): Promise<string> {
  const db = getDb();
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const hit = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, candidate))
      .limit(1);
    if (hit.length === 0) return candidate;
  }
  // Astronomically unlikely; if it happens, append a random suffix.
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

// Ensure the user has at least one workspace. If they already have one,
// returns the most-recently-created membership (or the owned one if any).
// Otherwise creates a Free-plan personal workspace and an owner membership.
export async function ensurePersonalWorkspace(args: {
  userId: string;
  email: string;
}): Promise<WorkspaceMembership> {
  const existing = await listMembershipsForUser(args.userId);
  if (existing.length > 0) {
    // Prefer the owned workspace; otherwise the first.
    const owned = existing.find((m) => m.isOwner);
    return owned ?? existing[0]!;
  }

  const free = await getPlanByCode("free");
  const slug = await findFreeSlug(emailToSlugBase(args.email));
  const name = `${args.email.split("@")[0]}'s workspace`;

  const db = getDb();
  const [ws] = await db
    .insert(schema.workspaces)
    .values({
      slug,
      name,
      ownerUserId: args.userId,
      planId: free.id,
    })
    .returning();
  if (!ws) throw new Error("failed to create personal workspace");

  await db.insert(schema.workspaceMembers).values({
    workspaceId: ws.id,
    userId: args.userId,
    role: "owner",
    acceptedAt: new Date(),
  });

  return {
    workspaceId: ws.id,
    workspaceSlug: ws.slug,
    workspaceName: ws.name,
    role: "owner",
    planId: ws.planId,
    isOwner: true,
  };
}

// Fast existence check used by the chooser UI.
export async function workspaceSlugExists(slug: string): Promise<boolean> {
  const db = getDb();
  const hit = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.slug, slug))
    .limit(1);
  return hit.length > 0;
}

// Lookup with membership check. Throws if the user isn't a member or the
// workspace is soft-deleted.
export async function loadWorkspaceForUser(args: {
  userId: string;
  workspaceId: string;
}): Promise<WorkspaceMembership | null> {
  const db = getDb();
  const rows = await db
    .select({
      workspaceId: schema.workspaces.id,
      workspaceSlug: schema.workspaces.slug,
      workspaceName: schema.workspaces.name,
      role: schema.workspaceMembers.role,
      planId: schema.workspaces.planId,
      ownerUserId: schema.workspaces.ownerUserId,
      deletedAt: schema.workspaces.deletedAt,
    })
    .from(schema.workspaceMembers)
    .innerJoin(
      schema.workspaces,
      eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
    )
    .where(
      and(
        eq(schema.workspaceMembers.userId, args.userId),
        eq(schema.workspaces.id, args.workspaceId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.deletedAt !== null) return null;
  return {
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
    workspaceName: row.workspaceName,
    role: row.role,
    planId: row.planId,
    isOwner: row.ownerUserId === args.userId,
  };
}

// Re-export so callers wiring manual plan pins can pick a plan id by code
// without importing from two places.
export { PLAN_IDS };
