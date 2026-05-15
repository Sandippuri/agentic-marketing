import Link from "next/link";
import { notFound } from "next/navigation";
import { getSuperWorkspaceDetail } from "@/lib/super/data";
import {
  PageHeader,
  Card,
  CardHeader,
  Badge,
  KV,
  EmptyState,
  StatusBadge,
} from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SuperWorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getSuperWorkspaceDetail(id);
  if (!detail) notFound();

  const { workspace, members, subscription, recentBillingEvents, usage } = detail;
  const acceptedMembers = members.filter((m) => m.acceptedAt !== null);
  const pendingMembers = members.filter((m) => m.acceptedAt === null);

  return (
    <div>
      <PageHeader
        title={workspace.name}
        description={
          <span className="mono text-xs">
            /{workspace.slug} · {workspace.id}
          </span>
        }
        meta={
          <>
            <Badge tone="neutral">{workspace.planCode}</Badge>
            {workspace.planOverriddenUntil && (
              <Badge tone="warn">
                override until {workspace.planOverriddenUntil.toLocaleDateString()}
              </Badge>
            )}
            {workspace.deletedAt ? (
              <Badge tone="danger" dot>
                deleted
              </Badge>
            ) : (
              <Badge tone="success" dot>
                live
              </Badge>
            )}
            <Badge tone="info">{acceptedMembers.length} members</Badge>
            {pendingMembers.length > 0 && (
              <Badge tone="warn">{pendingMembers.length} pending</Badge>
            )}
          </>
        }
        actions={
          <Link href="/super/workspaces" className="btn btn-ghost btn-sm">
            ← All workspaces
          </Link>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <Card className="lg:col-span-1">
          <CardHeader title="Workspace" />
          <div className="mt-3">
            <KV label="Name">{workspace.name}</KV>
            <KV label="Slug">
              <span className="mono text-xs">{workspace.slug}</span>
            </KV>
            <KV label="ID">
              <span className="mono text-xs">{workspace.id}</span>
            </KV>
            <KV label="Owner">
              {workspace.ownerEmail ? (
                <Link
                  href={`/super/users/${workspace.ownerUserId}`}
                  className="text-ink hover:underline"
                >
                  {workspace.ownerEmail}
                </Link>
              ) : (
                <span className="mono text-xs">{workspace.ownerUserId}</span>
              )}
            </KV>
            <KV label="Plan">{workspace.planCode}</KV>
            <KV label="Created">{workspace.createdAt.toLocaleString()}</KV>
            <KV label="Updated">{workspace.updatedAt.toLocaleString()}</KV>
            {workspace.deletedAt && (
              <KV label="Deleted">{workspace.deletedAt.toLocaleString()}</KV>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Subscription"
            description="Most recent subscription row for this workspace."
          />
          <div className="mt-3">
            {subscription ? (
              <div className="grid grid-cols-2 gap-x-6">
                <KV label="Status">
                  <StatusBadge status={subscription.status} />
                </KV>
                <KV label="Provider">
                  <Badge tone="neutral">{subscription.provider}</Badge>
                </KV>
                <KV label="Plan">
                  <Badge tone="accent">{subscription.planCode}</Badge>
                </KV>
                <KV label="Period">{subscription.billingPeriod}</KV>
                <KV label="Current start">
                  {subscription.currentPeriodStart.toLocaleDateString()}
                </KV>
                <KV label="Current end">
                  {subscription.currentPeriodEnd.toLocaleDateString()}
                </KV>
                <KV label="Trial end">
                  {subscription.trialEnd
                    ? subscription.trialEnd.toLocaleDateString()
                    : "—"}
                </KV>
                <KV label="Cancel at end">
                  {subscription.cancelAtPeriodEnd ? (
                    <Badge tone="warn">yes</Badge>
                  ) : (
                    "no"
                  )}
                </KV>
                <KV label="Canceled at">
                  {subscription.canceledAt
                    ? subscription.canceledAt.toLocaleString()
                    : "—"}
                </KV>
                <KV label="Subscription ID">
                  <span className="mono text-xs">{subscription.id}</span>
                </KV>
              </div>
            ) : (
              <EmptyState
                title="No subscription"
                description="Workspace has never had a subscription row. Free-plan tenants typically only get one once they upgrade."
              />
            )}
          </div>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader
          title="Members"
          description="Every accepted membership and pending invite."
        />
        <div className="mt-3">
          {members.length === 0 ? (
            <EmptyState
              title="No members"
              description="Workspace exists but nobody has joined."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Joined / invited</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.membershipId}>
                      <td>
                        {m.userId ? (
                          <Link
                            href={`/super/users/${m.userId}`}
                            className="text-ink hover:underline"
                          >
                            {m.email ?? m.invitedEmail ?? "—"}
                          </Link>
                        ) : (
                          <span>{m.invitedEmail ?? "—"}</span>
                        )}
                      </td>
                      <td>
                        <Badge tone="neutral">{m.role}</Badge>
                      </td>
                      <td>
                        {m.acceptedAt ? (
                          <Badge tone="success" dot>
                            active
                          </Badge>
                        ) : (
                          <Badge tone="warn" dot>
                            invited
                          </Badge>
                        )}
                      </td>
                      <td className="text-xs text-mid">
                        {(m.acceptedAt ?? m.invitedAt ?? m.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader
            title="Recent billing events"
            description="Last 15 webhook deliveries scoped to this workspace."
          />
          <div className="mt-3">
            {recentBillingEvents.length === 0 ? (
              <EmptyState
                title="No billing events"
                description="No webhook deliveries yet."
              />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {recentBillingEvents.map((e) => (
                  <li key={e.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="mono text-xs text-ink">{e.eventType}</span>
                      <Badge tone="neutral">{e.provider}</Badge>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-mid">
                      <span>{e.receivedAt.toLocaleString()}</span>
                      <span>
                        {e.processingError ? (
                          <Badge tone="danger">error</Badge>
                        ) : e.processedAt ? (
                          <Badge tone="success">processed</Badge>
                        ) : (
                          <Badge tone="warn">pending</Badge>
                        )}
                      </span>
                    </div>
                    {e.processingError && (
                      <div className="mt-1 text-xs text-[var(--danger)]">
                        {e.processingError}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Usage counters"
            description="Per-period rollups by metric."
          />
          <div className="mt-3">
            {usage.length === 0 ? (
              <EmptyState
                title="No usage yet"
                description="Counters appear once any metered action runs."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>Period</th>
                      <th className="text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.map((u, i) => (
                      <tr key={`${u.metric}-${u.periodStart}-${i}`}>
                        <td className="mono text-xs">{u.metric}</td>
                        <td className="text-xs text-mid">
                          {u.periodStart} → {u.periodEnd}
                        </td>
                        <td className="text-right mono">{u.value}</td>
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
