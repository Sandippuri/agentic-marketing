import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";
import { isAllowed } from "@/lib/auth-allowlist";

// Supabase magic-link callback. The link Supabase emails contains a `code`
// query param; we exchange it for a server-side session cookie, then verify
// the email is on AUTH_ALLOWLIST before letting them through.
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
  if (!isAllowed(data.user?.email)) {
    // Drop the just-created session so they don't keep an authenticated cookie.
    await supabase.auth.signOut();
    redirect(`/login?error=${encodeURIComponent("not_on_allowlist")}`);
  }

  redirect(next);
}
