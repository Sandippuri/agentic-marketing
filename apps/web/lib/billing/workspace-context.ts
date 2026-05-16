// Request-time workspace context resolver.
//
// Used by API routes and Server Components to answer: "which workspace is
// this request operating against, and what plan / role does the caller
// have?" Resolution order:
//   1. Explicit override via the `x-workspace-id` header (used by tests and
//      internal callers that already know the workspace).
//   2. The `active_workspace_id` cookie set by the workspace switcher.
//   3. The user's most-recently-used workspace (owner-membership wins).
//   4. Auto-provision a personal workspace on first authenticated hit.
//
// Always returns a context — never null — for authenticated callers. Callers
// that need to allow unauthenticated requests must catch UnauthorizedError.
//
// PR 2 only: nothing enforces the context yet. PR 4 wraps DB reads with
// getScopedDb(ctx.workspaceId); PR 5 wires entitlement checks against the
// plan/role on the returned context.

import { cookies } from "next/headers";
import { headers } from "next/headers";
import type { WorkspaceRole } from "@marketing/shared-types";
import { getSupabaseServer } from "../supabase/server";
import { UnauthorizedError } from "../auth";
import {
  ensurePersonalWorkspace,
  listMembershipsForUser,
  loadWorkspaceForUser,
  type WorkspaceMembership,
} from "./workspaces";
import { getPlanById, type LoadedPlan } from "./plans";
import { NotWorkspaceMemberError } from "./errors";

export const ACTIVE_WORKSPACE_COOKIE = "active_workspace_id";

export type WorkspaceContext = {
  userId: string;
  email: string | null;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  role: WorkspaceRole;
  isOwner: boolean;
  plan: LoadedPlan;
};

async function pickPreferredMembership(
  userId: string,
): Promise<WorkspaceMembership | null> {
  const ms = await listMembershipsForUser(userId);
  if (ms.length === 0) return null;
  return ms.find((m) => m.isOwner) ?? ms[0]!;
}

// Resolve the active context for the current request. Auto-provisions on
// first hit so the rest of the app can assume `ctx.workspaceId` exists.
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) throw new UnauthorizedError();
  const user = data.user;

  const hdrs = await headers();
  const headerOverride = hdrs.get("x-workspace-id");
  const cookieStore = await cookies();
  const cookieOverride = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;

  // Header / cookie override → verify membership and use it.
  for (const candidate of [headerOverride, cookieOverride]) {
    if (!candidate) continue;
    const m = await loadWorkspaceForUser({
      userId: user.id,
      workspaceId: candidate,
    });
    if (m) {
      const plan = await getPlanById(m.planId);
      return {
        userId: user.id,
        email: user.email ?? null,
        workspaceId: m.workspaceId,
        workspaceSlug: m.workspaceSlug,
        workspaceName: m.workspaceName,
        role: m.role,
        isOwner: m.isOwner,
        plan,
      };
    }
    // Override pointed at a workspace the user can't see → fall through to
    // "first available," but clear the bogus cookie so we don't loop next
    // request. Header overrides we leave alone (the caller set them).
    // Next 16 only permits cookie mutation in Server Actions / Route
    // Handlers; from a Server Component the delete throws. Swallow that —
    // the next mutation-capable request will clear the cookie instead.
    if (candidate === cookieOverride) {
      try {
        cookieStore.delete(ACTIVE_WORKSPACE_COOKIE);
      } catch {
        // No-op in Server Component render.
      }
    }
  }

  // No valid override → first available membership, provisioning if none.
  let pref = await pickPreferredMembership(user.id);
  if (!pref) {
    pref = await ensurePersonalWorkspace({
      userId: user.id,
      email: user.email ?? `${user.id}@unknown`,
    });
  }
  const plan = await getPlanById(pref.planId);
  return {
    userId: user.id,
    email: user.email ?? null,
    workspaceId: pref.workspaceId,
    workspaceSlug: pref.workspaceSlug,
    workspaceName: pref.workspaceName,
    role: pref.role,
    isOwner: pref.isOwner,
    plan,
  };
}

// Strict variant: explicit workspaceId, no fallback. Used by routes that
// already know which workspace the action targets (e.g. /api/workspaces/[id]/*).
// Throws NotWorkspaceMemberError if the caller isn't a member.
export async function getWorkspaceContextStrict(
  workspaceId: string,
): Promise<WorkspaceContext> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) throw new UnauthorizedError();
  const user = data.user;

  const m = await loadWorkspaceForUser({ userId: user.id, workspaceId });
  if (!m) throw new NotWorkspaceMemberError();
  const plan = await getPlanById(m.planId);
  return {
    userId: user.id,
    email: user.email ?? null,
    workspaceId: m.workspaceId,
    workspaceSlug: m.workspaceSlug,
    workspaceName: m.workspaceName,
    role: m.role,
    isOwner: m.isOwner,
    plan,
  };
}
