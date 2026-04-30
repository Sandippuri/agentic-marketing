import Link from "next/link";
import { isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { RealtimeInvalidator } from "@/lib/realtime-invalidator";

// Admin pages all read live Postgres state. Don't prerender.
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Pending approval count for the nav badge.
  const db = getDb();
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.approvals)
    .where(isNull(schema.approvals.decision));
  const pendingCount = countRows[0]?.count ?? 0;

  return (
    <div className="min-h-dvh grid grid-cols-[200px_1fr]">
      <aside className="border-r border-zinc-200 dark:border-zinc-800 p-4 flex flex-col">
        <Link href="/" className="font-semibold text-zinc-900 dark:text-zinc-100">
          Marketing
        </Link>
        <nav className="mt-6 flex flex-col gap-1 text-sm flex-1">
          <NavLink href="/campaigns">Campaigns</NavLink>
          <NavLink href="/approvals" badge={pendingCount > 0 ? pendingCount : undefined}>
            Approvals
          </NavLink>
          <NavLink href="/publish-jobs">Publish jobs</NavLink>
          <NavLink href="/insights">Insights</NavLink>
          <NavLink href="/audit-log">Audit log</NavLink>
          <NavLink href="/settings">Settings</NavLink>
        </nav>
      </aside>
      <main className="p-8">{children}</main>
      <RealtimeInvalidator />
    </div>
  );
}

function NavLink({
  href,
  children,
  badge,
}: {
  href: string;
  children: React.ReactNode;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-md px-2 py-1.5 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
    >
      <span>{children}</span>
      {badge !== undefined && (
        <span className="ml-2 rounded-full bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 leading-none">
          {badge}
        </span>
      )}
    </Link>
  );
}
