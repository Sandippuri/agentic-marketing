import Link from "next/link";
import { notFound } from "next/navigation";
import { getSuperUserDetail } from "@/lib/super/data";
import {
  PageHeader,
  Card,
  CardHeader,
  Badge,
  KV,
  EmptyState,
} from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SuperUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getSuperUserDetail(id);
  if (!detail) notFound();

  const { user, isSuperadmin, adminRole, memberships } = detail;
  const ownedCount = memberships.filter((m) => m.isOwner).length;
  const acceptedCount = memberships.filter((m) => m.acceptedAt !== null).length;
  const pendingCount = memberships.length - acceptedCount;

  return (
    <div>
      <PageHeader
        title={user.email}
        description={
          <span className="mono text-xs">{user.id}</span>
        }
        meta={
          <>
            {isSuperadmin && (
              <Badge tone="danger" dot>
                superadmin
              </Badge>
            )}
            {adminRole && adminRole !== "superadmin" && (
              <Badge tone="warn">{adminRole}</Badge>
            )}
            <Badge tone="neutral">{memberships.length} memberships</Badge>
            <Badge tone="info">{ownedCount} owned</Badge>
            {pendingCount > 0 && (
              <Badge tone="warn">{pendingCount} pending</Badge>
            )}
          </>
        }
        actions={
          <Link href="/super/users" className="btn btn-ghost btn-sm">
            ← All users
          </Link>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <Card className="lg:col-span-1">
          <CardHeader title="Account" />
          <div className="mt-3">
            <KV label="Email">{user.email}</KV>
            <KV label="User ID">
              <span className="mono text-xs">{user.id}</span>
            </KV>
            <KV label="Created">
              {new Date(user.createdAt).toLocaleString()}
            </KV>
            <KV label="Last sign-in">
              {user.lastSignInAt
                ? new Date(user.lastSignInAt).toLocaleString()
                : "never"}
            </KV>
            <KV label="Email confirmed">
              {user.emailConfirmedAt
                ? new Date(user.emailConfirmedAt).toLocaleString()
                : "no"}
            </KV>
            <KV label="Admin role">{adminRole ?? "—"}</KV>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Workspace memberships"
            description="Every tenant this user belongs to."
          />
          <div className="mt-3">
            {memberships.length === 0 ? (
              <EmptyState
                title="No memberships"
                description="User has confirmed an account but never landed in a workspace. Likely first-login provisioning failed."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Workspace</th>
                      <th>Role</th>
                      <th>Plan</th>
                      <th>Joined</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberships.map((m) => (
                      <tr key={m.workspaceId}>
                        <td>
                          <Link
                            href={`/super/workspaces/${m.workspaceId}`}
                            className="text-ink hover:underline"
                          >
                            {m.workspaceName}
                          </Link>
                          <div className="text-xs text-mid mono">
                            /{m.workspaceSlug}
                          </div>
                        </td>
                        <td>
                          <Badge tone={m.isOwner ? "accent" : "neutral"}>
                            {m.isOwner ? "owner" : m.role}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone="neutral">{m.planCode}</Badge>
                        </td>
                        <td className="text-xs text-mid">
                          {m.acceptedAt
                            ? new Date(m.acceptedAt).toLocaleDateString()
                            : m.invitedAt
                              ? `invited ${new Date(m.invitedAt).toLocaleDateString()}`
                              : "—"}
                        </td>
                        <td>
                          {m.acceptedAt ? (
                            <Badge tone="success" dot>
                              active
                            </Badge>
                          ) : (
                            <Badge tone="warn" dot>
                              pending
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
