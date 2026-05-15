import Link from "next/link";
import { listSuperWorkspaces } from "@/lib/super/data";
import {
  PageHeader,
  Badge,
  EmptyState,
  StatusBadge,
} from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SuperWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; deleted?: string }>;
}) {
  const { q = "", deleted } = await searchParams;
  const includeDeleted = deleted === "1";

  const all = await listSuperWorkspaces({ includeDeleted });
  const filtered = q
    ? all.filter(
        (w) =>
          w.name.toLowerCase().includes(q.toLowerCase()) ||
          w.slug.toLowerCase().includes(q.toLowerCase()) ||
          (w.ownerEmail ?? "").toLowerCase().includes(q.toLowerCase()),
      )
    : all;

  const liveCount = all.filter((w) => w.deletedAt === null).length;
  const deletedCount = all.length - liveCount;

  return (
    <div>
      <PageHeader
        title="Workspaces"
        description="Every tenant on this instance, with owner and current plan."
        meta={
          <>
            <Badge tone="info">{liveCount} live</Badge>
            {includeDeleted && deletedCount > 0 && (
              <Badge tone="danger">{deletedCount} deleted</Badge>
            )}
          </>
        }
      />

      <form className="surface mb-5 px-3 py-2.5 flex items-center gap-2 flex-wrap">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name, slug, owner email…"
          className="field flex-1 min-w-[220px]"
        />
        <label className="text-xs text-mid flex items-center gap-1.5">
          <input
            type="checkbox"
            name="deleted"
            value="1"
            defaultChecked={includeDeleted}
          />
          Show deleted
        </label>
        <button type="submit" className="btn btn-secondary btn-sm">
          Apply
        </button>
        {(q || includeDeleted) && (
          <Link href="/super/workspaces" className="btn btn-ghost btn-sm">
            Reset
          </Link>
        )}
      </form>

      {filtered.length === 0 ? (
        <EmptyState
          title={q ? "No matches" : "No workspaces"}
          description={
            q
              ? `Nothing matched "${q}".`
              : "Workspaces appear here as users sign up."
          }
        />
      ) : (
        <div className="table-card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Plan</th>
                <th>Subscription</th>
                <th className="text-right">Members</th>
                <th>Created</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link
                      href={`/super/workspaces/${w.id}`}
                      className="text-ink hover:underline"
                    >
                      {w.name}
                    </Link>
                    <div className="text-xs text-mid mono">/{w.slug}</div>
                  </td>
                  <td className="text-sm">
                    {w.ownerEmail ? (
                      <Link
                        href={`/super/users/${w.ownerUserId}`}
                        className="text-mid hover:text-ink hover:underline"
                      >
                        {w.ownerEmail}
                      </Link>
                    ) : (
                      <span className="text-faint mono text-xs">
                        {w.ownerUserId.slice(0, 8)}…
                      </span>
                    )}
                  </td>
                  <td>
                    <Badge tone="neutral">{w.planCode}</Badge>
                    {w.planOverriddenUntil && (
                      <Badge tone="warn" className="ml-1">
                        override
                      </Badge>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={w.subscriptionStatus} />
                  </td>
                  <td className="text-right mono">
                    {w.memberCount}
                    {w.pendingInviteCount > 0 && (
                      <span className="text-faint text-xs ml-1">
                        +{w.pendingInviteCount}
                      </span>
                    )}
                  </td>
                  <td className="text-xs text-mid">
                    {w.createdAt.toLocaleDateString()}
                  </td>
                  <td>
                    {w.deletedAt ? (
                      <Badge tone="danger" dot>
                        deleted
                      </Badge>
                    ) : (
                      <Badge tone="success" dot>
                        live
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
  );
}
