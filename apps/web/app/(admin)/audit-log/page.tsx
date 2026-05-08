import { desc, eq, and, gte, lte, type SQL } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { AuditLogTable } from "./audit-log-table";
import { PageHeader } from "../ui";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  actor?: string;
  action?: string;
  entity?: string;
  from?: string;
  to?: string;
  page?: string;
}>;

const PAGE_SIZE = 50;

export default async function AuditLogPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = getDb();

  const page = Math.max(1, Number(params.page ?? 1));
  const offset = (page - 1) * PAGE_SIZE;

  const filters: SQL[] = [];
  if (params.actor) filters.push(eq(schema.auditLog.actorKind, params.actor as "human" | "agent" | "system"));
  if (params.action) filters.push(eq(schema.auditLog.action, params.action));
  if (params.entity) filters.push(eq(schema.auditLog.entityType, params.entity));
  if (params.from) filters.push(gte(schema.auditLog.at, new Date(params.from)));
  if (params.to) filters.push(lte(schema.auditLog.at, new Date(params.to)));

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(whereClause)
    .orderBy(desc(schema.auditLog.at))
    .limit(PAGE_SIZE)
    .offset(offset);

  // Distinct action values for the filter dropdown.
  const actionRows = await db
    .selectDistinct({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .orderBy(schema.auditLog.action);
  const actions = actionRows.map((r) => r.action);

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every state-changing action across the control plane — humans, agents, and system jobs."
      />
      <AuditLogTable
        rows={rows.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          actorKind: r.actorKind,
          actorId: r.actorId ?? null,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId ?? null,
          before: r.before,
          after: r.after,
        }))}
        actions={actions}
        page={page}
        hasMore={rows.length === PAGE_SIZE}
        filters={{
          actor: params.actor ?? "",
          action: params.action ?? "",
          entity: params.entity ?? "",
          from: params.from ?? "",
          to: params.to ?? "",
        }}
      />
    </div>
  );
}
