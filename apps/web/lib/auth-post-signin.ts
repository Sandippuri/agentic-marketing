import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { isAllowed } from "@/lib/auth-allowlist";
import { ACTIVE_WORKSPACE_COOKIE, ensurePersonalWorkspace } from "@/lib/billing";

export type PostSigninResult =
  | { ok: true; redirectTo: string }
  | { ok: false; redirectTo: string };

// Shared post-signin gate. Runs after a session cookie exists, regardless of
// whether the session came from a magic link, password, or future SSO flow.
//
//   1. Enforces AUTH_ALLOWLIST (belt-and-suspenders sign-up gate).
//   2. Provisions a personal Free-plan workspace if the user has none.
//   3. Pins active_workspace_id cookie so the workspace context resolver
//      lands on the right tenant immediately.
//
// Caller is responsible for issuing the redirect — this returns the target.
export async function runPostSignin(args: {
  user: User;
  signOut: () => Promise<unknown>;
  next: string;
}): Promise<PostSigninResult> {
  const { user, signOut, next } = args;

  if (!isAllowed(user.email)) {
    await signOut();
    return {
      ok: false,
      redirectTo: `/login?error=${encodeURIComponent("not_on_allowlist")}`,
    };
  }

  let membershipId: string | null = null;
  try {
    const membership = await ensurePersonalWorkspace({
      userId: user.id,
      email: user.email ?? `${user.id}@unknown.local`,
    });
    membershipId = membership.workspaceId;
  } catch (provisionErr) {
    // Don't lock the user out on provisioning failure; lazy path picks up.
    console.error("[post-signin] workspace provisioning failed", provisionErr);
  }

  if (membershipId) {
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_WORKSPACE_COOKIE, membershipId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return { ok: true, redirectTo: next };
}
