import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role Supabase client. Server-only. Never import from a client
// component. Used by /super/* to read auth.users and any other privileged
// resource. storage.ts has its own copy of this factory — leave it; this
// module is for admin/auth-API callers, not storage.
export function getSupabaseServiceRole(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
};

export async function listAllAuthUsers(): Promise<AuthUser[]> {
  const sb = getSupabaseServiceRole();
  const out: AuthUser[] = [];
  let page = 1;
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    for (const u of data.users) {
      if (!u.email) continue;
      out.push({
        id: u.id,
        email: u.email,
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at ?? null,
        emailConfirmedAt: u.email_confirmed_at ?? null,
      });
    }
    if (data.users.length < 1000) break;
    page += 1;
  }
  return out;
}

export async function getAuthUser(userId: string): Promise<AuthUser | null> {
  const sb = getSupabaseServiceRole();
  const { data, error } = await sb.auth.admin.getUserById(userId);
  if (error) return null;
  const u = data.user;
  if (!u || !u.email) return null;
  return {
    id: u.id,
    email: u.email,
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at ?? null,
    emailConfirmedAt: u.email_confirmed_at ?? null,
  };
}
