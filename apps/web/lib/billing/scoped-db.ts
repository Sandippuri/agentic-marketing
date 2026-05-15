// Workspace scoping helpers for Drizzle reads.
//
// Design: we deliberately do NOT wrap Drizzle in a proxy. Every Route Handler
// that touches a tenant table calls `whereInWorkspace(table, ctx, …)` to
// build the where clause. The convention is enforced by:
//   1. Code review on PR 4 (the cluster of route migrations).
//   2. Cross-tenant isolation tests (one per converted route).
//   3. PR 9 RLS backstop — the DB itself refuses cross-tenant reads when
//      the session GUC is set.
//
// Trade-off vs a proxy: less magic, no false sense of safety, all the
// filtering is grep-able. The cost is the convention is opt-in — that's
// what the tests are for.
//
// Internal-token callers (Manager / Distributor cron) pass `null` for the
// context, which omits the workspace filter. PR 5 tightens this so internal
// callers MUST also identify a workspace (single-tenant legacy access falls
// away once the bootstrap is complete).

import { and, eq, type Column, type SQL } from "drizzle-orm";
import type { WorkspaceContext } from "./workspace-context";

export type TenantTable = { workspaceId: Column };

// Equality predicate. Returns undefined when ctx is null so it composes
// cleanly with optional `where`.
export function workspaceWhere<T extends TenantTable>(
  table: T,
  ctx: WorkspaceContext | null,
): SQL | undefined {
  if (!ctx) return undefined;
  return eq(table.workspaceId, ctx.workspaceId);
}

// Combine the workspace filter with any number of additional conditions.
// `extra` may contain `undefined` entries (e.g. optional status filters);
// those are dropped before the AND.
export function whereInWorkspace<T extends TenantTable>(
  table: T,
  ctx: WorkspaceContext | null,
  ...extra: (SQL | undefined)[]
): SQL | undefined {
  const conditions: SQL[] = [];
  const w = workspaceWhere(table, ctx);
  if (w) conditions.push(w);
  for (const c of extra) if (c) conditions.push(c);
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

// For INSERTs: stamp the workspace_id onto the values object. Throws when
// ctx is null AND legacyWorkspaceId isn't provided — most insert sites
// must have a workspace, but legacy internal callers can opt in by passing
// a fixed Legacy workspace id (PR 5 removes this escape hatch).
export const LEGACY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

export function withWorkspaceField<T extends object>(
  values: T,
  ctx: WorkspaceContext | null,
  fallback?: string,
): T & { workspaceId: string } {
  const id = ctx?.workspaceId ?? fallback;
  if (!id) {
    throw new Error(
      "withWorkspaceField: no WorkspaceContext and no fallback id provided",
    );
  }
  return { ...values, workspaceId: id };
}
