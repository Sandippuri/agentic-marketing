import Link from "next/link";
import { redirect } from "next/navigation";
import { sql, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getSupabaseServer } from "@/lib/supabase/server";
import { lookupAdminRole } from "@/lib/billing/admin";
import { SuperSidebarNav, type SuperNavSection } from "./sidebar-nav";
import { SignoutButton } from "../(admin)/signout-button";

// /super/* is the cross-tenant operator console. Every page reads global state
// — never tenant-scoped. requireSuperadmin() throws inside route handlers; in
// pages we redirect instead so the user lands on /login or /campaigns.
export const dynamic = "force-dynamic";

export default async function SuperLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sb = await getSupabaseServer();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) {
    redirect("/login?next=/super");
  }
  const role = await lookupAdminRole(data.user.id);
  if (role !== "superadmin") {
    // Not a superadmin — bounce to the regular workspace UI.
    redirect("/campaigns");
  }

  const db = getDb();
  const [usersCountRow, workspacesCountRow, pendingInvitesRow] = await Promise.all([
    // auth.users lives outside our schema; use service-role for the precise
    // number on the dashboard. Sidebar badges use cheap counts only.
    db
      .select({ n: sql<number>`count(distinct ${schema.workspaceMembers.userId})::int` })
      .from(schema.workspaceMembers)
      .where(sql`${schema.workspaceMembers.userId} is not null`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.workspaces)
      .where(isNull(schema.workspaces.deletedAt)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.workspaceMembers)
      .where(isNull(schema.workspaceMembers.acceptedAt)),
  ]);

  const sections: SuperNavSection[] = [
    {
      label: "Platform",
      items: [
        { href: "/super", label: "Overview" },
        {
          href: "/super/users",
          label: "Users",
          badge: usersCountRow[0]?.n ?? 0,
        },
        {
          href: "/super/workspaces",
          label: "Workspaces",
          badge: workspacesCountRow[0]?.n ?? 0,
        },
        { href: "/super/subscriptions", label: "Subscriptions" },
      ],
    },
    {
      label: "Configuration",
      items: [
        { href: "/super/models", label: "Models & processes" },
        { href: "/super/usage", label: "Usage" },
      ],
    },
    {
      label: "Operations",
      items: [
        {
          href: "/super/invites",
          label: "Pending invites",
          badge: pendingInvitesRow[0]?.n ?? 0,
        },
      ],
    },
    {
      label: "Account",
      items: [{ href: "/campaigns", label: "← Back to workspace" }],
    },
  ];

  return (
    <div className="min-h-dvh grid grid-cols-[240px_1fr] bg-[var(--bg)]">
      <aside className="hairline-r border-r border-[var(--border)] bg-[var(--bg-elevated)] flex flex-col sticky top-0 h-dvh">
        <Link
          href="/super"
          className="flex items-center gap-2.5 px-5 h-14 border-b border-[var(--border)] hover:opacity-90 transition-opacity"
        >
          <span className="grid place-items-center h-7 w-7 rounded-md bg-[var(--danger)] text-white shadow-sm">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
            </svg>
          </span>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-ink">Superadmin</div>
            <div className="text-[10.5px] text-faint tracking-wide">
              Platform Console
            </div>
          </div>
        </Link>

        <SuperSidebarNav sections={sections} />

        <div className="px-4 py-3 border-t border-[var(--border)] text-[11px] text-faint flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="mono truncate" title={data.user.email ?? undefined}>
              {data.user.email ?? "—"}
            </span>
            <SignoutButton />
          </div>
          <div className="flex items-center">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--danger)] live-dot" />
              Operator
            </span>
          </div>
        </div>
      </aside>

      <main className="min-w-0">
        <div className="px-8 py-7 max-w-[1400px] mx-auto">{children}</div>
      </main>
    </div>
  );
}
