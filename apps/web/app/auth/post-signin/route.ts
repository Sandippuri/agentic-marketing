import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";
import { runPostSignin } from "@/lib/auth-post-signin";

// Password sign-ins (and any other client-side flow that produces a session
// without going through /auth/callback) bounce through here to run the same
// allowlist + workspace-provisioning gate the magic-link path runs.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") ?? "/campaigns";

  const supabase = await getSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    redirect(`/login?error=${encodeURIComponent("no_session")}`);
  }

  const result = await runPostSignin({
    user: data.user,
    signOut: () => supabase.auth.signOut(),
    next,
  });
  redirect(result.redirectTo);
}
