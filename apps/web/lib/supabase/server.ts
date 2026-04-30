import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// Server-side Supabase client used in Server Components and Route Handlers.
// Reads the user's session from cookies; writes new cookies on refresh.
export async function getSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: { name: string; value: string; options?: Parameters<typeof cookieStore.set>[2] }[]) => {
          for (const c of toSet) {
            cookieStore.set(c.name, c.value, c.options);
          }
        },
      },
    },
  );
}
