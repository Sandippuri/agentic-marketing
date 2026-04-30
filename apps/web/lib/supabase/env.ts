// Public Supabase URL/anon key, exposed to the browser via NEXT_PUBLIC_*.
// Server code can use SUPABASE_URL / SUPABASE_ANON_KEY directly. We resolve
// here so a missing var is one error, not three.

function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const supabasePublic = {
  url: need(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  ),
  anonKey: need(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY,
  ),
};
