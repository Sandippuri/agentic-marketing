import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// In Next 16 the file convention is `proxy.ts` (the old `middleware.ts` was
// renamed). Refresh Supabase Auth cookies on every admin request, and gate
// non-API admin paths behind an authenticated session.
//
// Internal-token callers (Manager / Distributor) bypass this by hitting
// /api/* with the x-internal-token header — Route Handlers verify the token
// themselves and don't depend on a Supabase session.

const PUBLIC_PATHS = ["/", "/blog", "/login", "/auth"];

export async function proxy(request: NextRequest) {
  const url = request.nextUrl.clone();
  const path = url.pathname;

  // Public site (blog) and auth pages don't require a session.
  const isPublic = PUBLIC_PATHS.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
  if (isPublic) return NextResponse.next();

  // API routes handle their own auth (Supabase session OR internal token).
  if (path.startsWith("/api/")) return NextResponse.next();

  // Admin routes: require an authenticated Supabase session.
  const response = NextResponse.next();
  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (
          toSet: { name: string; value: string; options?: Parameters<typeof response.cookies.set>[2] }[],
        ) => {
          for (const c of toSet) response.cookies.set(c.name, c.value, c.options);
        },
      },
    },
  );
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: [
    // Run on everything except _next assets, static files, and favicon.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)).*)",
  ],
};
