import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import type { DesignLogo, DesignLogoVariant } from "@marketing/shared-types";
import { RealtimeInvalidator } from "@/lib/realtime-invalidator";
import { getSupabaseServer } from "@/lib/supabase/server";
import { lookupAdminRole } from "@/lib/billing/admin";
import { getWorkspaceContext } from "@/lib/billing";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { SidebarNav, type NavSection } from "./sidebar-nav";
import { SignoutButton } from "./signout-button";

// Order we'd rather render a sidebar logo in: a square mark first (fits the
// 28px slot best), then mono / wordmark / light / dark as fallbacks.
const LOGO_VARIANT_PREFERENCE: DesignLogoVariant[] = [
  "mark",
  "monochrome",
  "wordmark",
  "light",
  "dark",
];

function pickSidebarLogo(logos: DesignLogo[]): DesignLogo | null {
  for (const v of LOGO_VARIANT_PREFERENCE) {
    const hit = logos.find((l) => l.variant === v);
    if (hit) return hit;
  }
  return logos[0] ?? null;
}

// Admin pages all read live Postgres state. Don't prerender.
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const db = getDb();

  // Only superadmins see the /super link. Cheap read; lookupAdminRole hits a
  // tiny indexed table.
  const sb = await getSupabaseServer();
  const { data: userData } = await sb.auth.getUser();
  const adminRole = userData.user
    ? await lookupAdminRole(userData.user.id)
    : null;
  const isSuperadmin = adminRole === "superadmin";

  const ctx = userData.user ? await getWorkspaceContext() : null;

  // Pull the workspace's uploaded brand logo so the sidebar header reflects
  // the actual brand. Falls back to the generic accent-square placeholder
  // when no logo is set or the signed-URL fetch fails.
  let sidebarLogoUrl: string | null = null;
  if (ctx) {
    const [dsRow] = await db
      .select({ logos: schema.brandDesignSystem.logos })
      .from(schema.brandDesignSystem)
      .where(
        and(
          eq(schema.brandDesignSystem.workspaceId, ctx.workspaceId),
          eq(schema.brandDesignSystem.slug, "default"),
        ),
      )
      .limit(1);
    const picked = pickSidebarLogo(dsRow?.logos ?? []);
    if (picked) {
      try {
        sidebarLogoUrl = await getSignedAssetUrl(picked.storagePath);
      } catch {
        sidebarLogoUrl = null;
      }
    }
  }

  const countRows = ctx
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.workspaceId, ctx.workspaceId),
            isNull(schema.approvals.decision),
          ),
        )
    : [{ count: 0 }];
  const pendingCount = countRows[0]?.count ?? 0;

  // Onboarding gate: brand_memory is the canonical signal. Superadmins are
  // exempt because /super is their landing surface. Skip when the user has
  // no session (the page-level auth check will redirect them to /login).
  if (ctx && !isSuperadmin) {
    const brandMemoryRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.brandMemory)
      .where(eq(schema.brandMemory.workspaceId, ctx.workspaceId));
    if ((brandMemoryRows[0]?.count ?? 0) === 0) {
      redirect("/onboarding");
    }
  }

  // Sidebar split by audience:
  //   * Platform users see their own workspace's data — campaigns, the
  //     creation workflow live view, approvals, publish jobs, workflow runs,
  //     and the learning loop are all per-workspace and safe to show.
  //   * Operator-only items (audit log, debug chat) only render for
  //     superadmins. The page routes themselves also guard server-side, so
  //     hiding the link is defence-in-depth, not the access control.
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
        { href: "/research", label: "Research", icon: "insights" },
        { href: "/learning", label: "Learning loop", icon: "insights" },
        ...(isSuperadmin
          ? [{ href: "/audit-log", label: "Audit log", icon: "audit" as const }]
          : []),
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
        { href: "/integrations", label: "Integrations", icon: "plug" },
        { href: "/settings", label: "Settings", icon: "settings" },
      ],
    },
  ];

  // Pinned at the very top of the sidebar — the workspace's primary command
  // surface. Every signed-in user sees it.
  const pinned = [
    { href: "/test-chat", label: "Assistant", icon: "chat" },
  ];

  if (isSuperadmin) {
    sections.push({
      label: "Operator",
      items: [{ href: "/super", label: "Superadmin", icon: "settings" }],
    });
  }

  return (
    <div className="min-h-dvh grid grid-cols-[240px_1fr] bg-[var(--bg)]">
      <aside className="hairline-r border-r border-[var(--border)] bg-[var(--bg-elevated)] flex flex-col sticky top-0 h-dvh">
        <Link
          href="/"
          className="flex items-center gap-2.5 px-5 h-14 border-b border-[var(--border)] hover:opacity-90 transition-opacity"
        >
          {sidebarLogoUrl ? (
            // The slot is a 28px square; object-contain keeps wordmarks
            // readable without distorting marks. Background stays neutral so
            // logos on transparent PNGs don't blend into the elevated sidebar.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={sidebarLogoUrl}
              alt={`${ctx?.workspaceName ?? "Workspace"} logo`}
              className="h-7 w-7 rounded-md object-contain bg-[var(--bg)] shadow-sm"
            />
          ) : (
            <span className="grid place-items-center h-7 w-7 rounded-md bg-[var(--accent)] text-white shadow-sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19V5l8 8 8-8v14" />
              </svg>
            </span>
          )}
          <div className="leading-tight min-w-0">
            <div className="text-[13px] font-semibold text-ink truncate">
              {ctx?.workspaceName ?? "Marketing"}
            </div>
            <div className="text-[10.5px] text-faint tracking-wide">Control Plane</div>
          </div>
        </Link>

        <SidebarNav pinned={pinned} sections={sections} />

        <div className="px-4 py-3 border-t border-[var(--border)] text-[11px] text-faint flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="mono truncate" title={userData.user?.email ?? undefined}>
              {userData.user?.email ?? "—"}
            </span>
            <SignoutButton />
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)] live-dot" />
              Live
            </span>
            <span className="mono">v0.1</span>
          </div>
        </div>
      </aside>

      <main className="min-w-0">
        <div className="px-8 py-7 max-w-[1400px] mx-auto">{children}</div>
      </main>
      <RealtimeInvalidator />
    </div>
  );
}
