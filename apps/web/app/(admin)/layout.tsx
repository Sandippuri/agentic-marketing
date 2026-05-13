import Link from "next/link";
import { isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { RealtimeInvalidator } from "@/lib/realtime-invalidator";
import { SidebarNav, type NavSection } from "./sidebar-nav";

// Admin pages all read live Postgres state. Don't prerender.
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const db = getDb();
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.approvals)
    .where(isNull(schema.approvals.decision));
  const pendingCount = countRows[0]?.count ?? 0;

  const sections: NavSection[] = [
    {
      label: "Workspace",
      items: [
        { href: "/campaigns", label: "Campaigns", icon: "campaigns" },
        { href: "/creation-workflow", label: "Creation workflow", icon: "workflow" },
        { href: "/approvals", label: "Approvals", icon: "approvals", badge: pendingCount },
        { href: "/publish-jobs", label: "Publish jobs", icon: "publish" },
        { href: "/runs", label: "Workflow runs", icon: "workflow" },
      ],
    },
    {
      label: "Content",
      items: [
        { href: "/posts", label: "Posts", icon: "posts" },
        { href: "/gallery", label: "Gallery", icon: "gallery" },
        { href: "/insights", label: "Insights", icon: "insights" },
        { href: "/learning", label: "Learning loop", icon: "insights" },
        { href: "/research", label: "Research", icon: "insights" },
        { href: "/audit-log", label: "Audit log", icon: "audit" },
      ],
    },
    {
      label: "Brand",
      items: [
        { href: "/brand", label: "Brand", icon: "brand" },
        { href: "/knowledge", label: "Knowledge base", icon: "posts" },
        {
          href: "/knowledge/visual-references",
          label: "Visual references",
          icon: "gallery",
        },
      ],
    },
    {
      label: "System",
      items: [
        { href: "/test-chat", label: "Test chat", icon: "chat" },
        { href: "/integrations", label: "Integrations", icon: "plug" },
        { href: "/settings", label: "Settings", icon: "settings" },
      ],
    },
  ];

  return (
    <div className="min-h-dvh grid grid-cols-[240px_1fr] bg-[var(--bg)]">
      <aside className="hairline-r border-r border-[var(--border)] bg-[var(--bg-elevated)] flex flex-col sticky top-0 h-dvh">
        <Link
          href="/"
          className="flex items-center gap-2.5 px-5 h-14 border-b border-[var(--border)] hover:opacity-90 transition-opacity"
        >
          <span className="grid place-items-center h-7 w-7 rounded-md bg-[var(--accent)] text-white shadow-sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19V5l8 8 8-8v14" />
            </svg>
          </span>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-ink">Marketing</div>
            <div className="text-[10.5px] text-faint tracking-wide">Control Plane</div>
          </div>
        </Link>

        <SidebarNav sections={sections} />

        <div className="px-4 py-3 border-t border-[var(--border)] text-[11px] text-faint flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)] live-dot" />
            Live
          </span>
          <span className="mono">v0.1</span>
        </div>
      </aside>

      <main className="min-w-0">
        <div className="px-8 py-7 max-w-[1400px] mx-auto">{children}</div>
      </main>
      <RealtimeInvalidator />
    </div>
  );
}
