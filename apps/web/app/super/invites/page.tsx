import Link from "next/link";
import { desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { PageHeader, Badge, EmptyState } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SuperInvitesPage() {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.workspaceMembers.id,
      workspaceId: schema.workspaceMembers.workspaceId,
      role: schema.workspaceMembers.role,
      invitedEmail: schema.workspaceMembers.invitedEmail,
      invitedAt: schema.workspaceMembers.invitedAt,
      createdAt: schema.workspaceMembers.createdAt,
      workspaceName: schema.workspaces.name,
      workspaceSlug: schema.workspaces.slug,
    })
    .from(schema.workspaceMembers)
    .innerJoin(
      schema.workspaces,
      eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
    )
    .where(isNull(schema.workspaceMembers.acceptedAt))
    .orderBy(desc(schema.workspaceMembers.invitedAt));

  return (
    <div>
      <PageHeader
        title="Pending invites"
        description="Workspace memberships that have been invited but not yet accepted."
        meta={<Badge tone="warn">{rows.length} pending</Badge>}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No pending invites"
          description="Every membership has been accepted."
        />
      ) : (
        <div className="table-card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Workspace</th>
                <th>Role</th>
                <th>Invited</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-sm text-ink">{r.invitedEmail ?? "—"}</td>
                  <td>
                    <Link
                      href={`/super/workspaces/${r.workspaceId}`}
                      className="text-ink hover:underline"
                    >
                      {r.workspaceName}
                    </Link>
                    <div className="text-xs text-mid mono">/{r.workspaceSlug}</div>
                  </td>
                  <td>
                    <Badge tone="neutral">{r.role}</Badge>
                  </td>
                  <td className="text-xs text-mid">
                    {r.invitedAt ? r.invitedAt.toLocaleString() : "—"}
                  </td>
                  <td className="text-xs text-mid">
                    {r.createdAt.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
