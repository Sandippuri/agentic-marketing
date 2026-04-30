import { schema, type Database } from "@marketing/db";
import type { ActorKind } from "@marketing/shared-types";

export type AuditActor = {
  id: string | null;
  kind: ActorKind;
};

export type AuditContext = {
  db: Database;
  actor: AuditActor;
  action: string;
  entityType: string;
};

// Higher-order helper: wraps any mutation, captures before/after, writes one
// audit_log row per call. Used on every mutating Route Handler.
//
// Usage:
//   const updated = await withAudit(
//     { db, actor, action: 'content.approve', entityType: 'content_items' },
//     () => loadContent(id),
//     async () => updateContent(id, patch),
//   );
export async function withAudit<TBefore, TAfter>(
  ctx: AuditContext,
  loadBefore: () => Promise<TBefore | null>,
  mutate: () => Promise<TAfter>,
): Promise<TAfter> {
  const before = await loadBefore();
  const after = await mutate();
  await ctx.db.insert(schema.auditLog).values({
    actorId: ctx.actor.id ?? null,
    actorKind: ctx.actor.kind,
    action: ctx.action,
    entityType: ctx.entityType,
    entityId: extractEntityId(after) ?? extractEntityId(before),
    before: before as object | null,
    after: after as object | null,
  });
  return after;
}

function extractEntityId(value: unknown): string | null {
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }
  return null;
}
