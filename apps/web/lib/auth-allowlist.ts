// Domain or full-email allowlist for sign-in. Without this, anyone with a
// Supabase magic-link could land in the admin UI.
//
// AUTH_ALLOWLIST is a comma-separated list. Each entry is either:
//   - "venture23.io"   — any email at that domain
//   - "alice@team.com" — exact match
// Empty / unset list = deny everyone (fail closed).

export class AuthAllowlistError extends Error {
  constructor(public email: string) {
    super(`email ${email} is not on AUTH_ALLOWLIST`);
  }
}

export function isAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.AUTH_ALLOWLIST ?? "";
  const entries = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return false;
  const lower = email.toLowerCase();
  for (const entry of entries) {
    if (entry.includes("@")) {
      if (entry === lower) return true;
    } else {
      if (lower.endsWith(`@${entry}`)) return true;
    }
  }
  return false;
}
