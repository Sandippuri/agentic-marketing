import Link from "next/link";
import { listSuperUsers } from "@/lib/super/data";
import {
  PageHeader,
  Badge,
  EmptyState,
} from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SuperUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const users = await listSuperUsers();
  const filtered = q
    ? users.filter((u) => u.email.toLowerCase().includes(q.toLowerCase()))
    : users;

  return (
    <div>
      <PageHeader
        title="Users"
        description="Every confirmed Supabase user on this instance, joined to their workspace memberships."
        meta={
          <>
            <Badge tone="neutral">{users.length} total</Badge>
            <Badge tone="danger">
              {users.filter((u) => u.isSuperadmin).length} superadmin
            </Badge>
            <Badge tone="info">
              {users.filter((u) => u.workspaceCount === 0).length} workspaceless
            </Badge>
          </>
        }
      />

      <form className="surface mb-5 px-3 py-2.5 flex items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by email…"
          className="field flex-1"
        />
        <button type="submit" className="btn btn-secondary btn-sm">
          Search
        </button>
        {q && (
          <Link href="/super/users" className="btn btn-ghost btn-sm">
            Clear
          </Link>
        )}
      </form>

      {filtered.length === 0 ? (
        <EmptyState
          title={q ? "No matches" : "No users"}
          description={q ? `Nothing matched "${q}".` : "Sign-ups land here."}
        />
      ) : (
        <div className="table-card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th className="text-right">Workspaces</th>
                <th className="text-right">Owned</th>
                <th>Last sign-in</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link
                      href={`/super/users/${u.id}`}
                      className="text-ink hover:underline"
                    >
                      {u.email}
                    </Link>
                  </td>
                  <td>
                    {u.isSuperadmin ? (
                      <Badge tone="danger" dot>
                        superadmin
                      </Badge>
                    ) : (
                      <Badge tone="neutral">user</Badge>
                    )}
                  </td>
                  <td className="text-right mono">{u.workspaceCount}</td>
                  <td className="text-right mono">{u.ownedCount}</td>
                  <td className="text-xs text-mid">
                    {u.lastSignInAt ? formatRelative(u.lastSignInAt) : "never"}
                  </td>
                  <td className="text-xs text-mid">
                    {formatRelative(u.createdAt)}
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
