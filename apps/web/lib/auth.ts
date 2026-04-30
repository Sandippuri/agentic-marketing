import { getSupabaseServer } from "./supabase/server";
import type { AuditActor } from "./audit";

export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
  }
}

// Resolve the human actor for a given request. Throws if no session.
// Internal (service-token) callers should use a synthetic agent actor instead.
export async function getRequestActor(): Promise<AuditActor> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) throw new UnauthorizedError();
  return { id: data.user.id, kind: "human" };
}

export const SYSTEM_ACTOR: AuditActor = { id: null, kind: "system" };
export const AGENT_ACTOR: AuditActor = { id: null, kind: "agent" };
