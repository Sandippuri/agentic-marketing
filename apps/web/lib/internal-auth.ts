// Service-to-service auth for OpenClaw (manager / distributor) calling the
// Control Plane. Plan §5 Phase 1 Day 5.

const HEADER = "x-internal-token";
const WORKSPACE_HEADER = "x-workspace-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Internal callers (workflows, cron, manager) historically all wrote to the
 * Legacy workspace because there was no way to pass which workspace they
 * actually meant. Now they send `x-workspace-id` alongside the internal
 * token; this returns that workspace when the header is a valid UUID, or
 * `null` so the caller can fall back to Legacy for backwards-compat.
 *
 * We deliberately do NOT verify membership here — internal callers are
 * trusted by the token; the bouncer is `assertInternal` on the same route.
 */
export function internalWorkspaceOverride(request: Request): string | null {
  const raw = request.headers.get(WORKSPACE_HEADER);
  if (!raw) return null;
  return UUID_RE.test(raw) ? raw : null;
}

export class InternalAuthError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function assertInternal(request: Request): void {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    throw new InternalAuthError("INTERNAL_API_TOKEN is not configured");
  }
  const provided = request.headers.get(HEADER);
  if (!provided || !timingSafeEqual(provided, expected)) {
    throw new InternalAuthError("missing or invalid internal token");
  }
}

export function isInternal(request: Request): boolean {
  try {
    assertInternal(request);
    return true;
  } catch {
    return false;
  }
}

// Constant-time compare so token-shape probing can't differentiate by timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
