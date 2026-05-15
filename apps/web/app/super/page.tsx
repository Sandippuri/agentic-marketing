import Link from "next/link";
import { getPlatformOverview } from "@/lib/super/data";
import { PageHeader, Card, CardHeader, Stat, Badge, EmptyState } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SuperOverviewPage() {
  const overview = await getPlatformOverview();
  const { totals, recentSignups, recentWorkspaces } = overview;

  return (
    <div>
      <PageHeader
        title="Platform overview"
        description="Cross-tenant view of every user, workspace, and subscription on this instance."
        meta={
          <>
            <Badge tone="danger" dot>
              superadmin
            </Badge>
            <Badge tone="neutral">{totals.users} users</Badge>
            <Badge tone="info">{totals.workspaces} workspaces</Badge>
            <Badge tone="success">{totals.activeSubscriptions} active subs</Badge>
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Stat label="Users" value={totals.users} hint="all confirmed accounts" />
        <Stat
          label="Workspaces"
          value={totals.workspaces}
          hint="non-deleted tenants"
          tone="accent"
        />
        <Stat
          label="Active subs"
          value={totals.activeSubscriptions}
          hint="trialing + active + grace + past_due"
          tone="success"
        />
        <Stat
          label="Pending invites"
          value={totals.pendingInvites}
          hint="memberships unaccepted"
          tone={totals.pendingInvites > 0 ? "warn" : "default"}
        />
        <Stat
          label="Superadmins"
          value={totals.superadmins}
          hint="rows in admin_users"
          tone="danger"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader
            title="Recent signups"
            description="Latest 8 confirmed sign-ins"
            actions={
              <Link href="/super/users" className="text-xs text-mid hover:text-ink">
                All users →
              </Link>
            }
          />
          <div className="mt-4">
            {recentSignups.length === 0 ? (
              <EmptyState
                title="No users yet"
                description="Sign-ups appear here as they arrive."
              />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {recentSignups.map((u) => (
                  <li
                    key={u.id}
                    className="flex items-center justify-between py-2 text-sm"
                  >
                    <Link
                      href={`/super/users/${u.id}`}
                      className="min-w-0 truncate text-ink hover:underline"
                    >
                      {u.email}
                    </Link>
                    <span className="text-xs text-mid mono">
                      {formatRelative(u.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Recent workspaces"
            description="Latest 8 created"
            actions={
              <Link
                href="/super/workspaces"
                className="text-xs text-mid hover:text-ink"
              >
                All workspaces →
              </Link>
            }
          />
          <div className="mt-4">
            {recentWorkspaces.length === 0 ? (
              <EmptyState
                title="No workspaces yet"
                description="Created on first sign-in or by invite."
              />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {recentWorkspaces.map((w) => (
                  <li key={w.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <Link
                        href={`/super/workspaces/${w.id}`}
                        className="min-w-0 truncate text-ink hover:underline"
                      >
                        {w.name}
                      </Link>
                      <Badge tone="neutral">{w.planCode}</Badge>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-mid">
                      <span className="truncate">{w.ownerEmail ?? w.ownerUserId}</span>
                      <span className="mono">
                        {w.memberCount} {w.memberCount === 1 ? "member" : "members"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
