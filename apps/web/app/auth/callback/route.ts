import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";
import { runPostSignin } from "@/lib/auth-post-signin";

// Supabase magic-link callback. The link Supabase emails contains a `code`
// query param; we exchange it for a server-side session cookie, then run the
// shared post-signin gate (allowlist + workspace provisioning).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/campaigns";

  if (!code) {
    redirect(`/login?error=${encodeURIComponent("missing_code")}`);
  }

  const supabase = await getSupabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    redirect(`/login?error=${encodeURIComponent("no_user")}`);
  }

  const result = await runPostSignin({
    user: data.user,
    signOut: () => supabase.auth.signOut(),
    next,
  });
  redirect(result.redirectTo);
}
