import Link from "next/link";
import { listSuperSubscriptions } from "@/lib/super/data";
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@marketing/shared-types";
import {
  PageHeader,
  Badge,
  EmptyState,
  StatusBadge,
} from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SuperSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const status = SUBSCRIPTION_STATUSES.includes(
    params.status as SubscriptionStatus,
  )
    ? (params.status as SubscriptionStatus)
    : undefined;

  const rows = await listSuperSubscriptions({ status });

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        description="Every subscription row across all workspaces, ordered by most recent."
        meta={
          <>
            <Badge tone="neutral">{rows.length} shown</Badge>
            {status && <Badge tone="info">filter: {status}</Badge>}
          </>
        }
      />

      <div className="surface mb-5 px-3 py-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">
          Status
        </span>
        <FilterPill href="/super/subscriptions" active={!status}>
          all
        </FilterPill>
        {SUBSCRIPTION_STATUSES.map((s) => (
          <FilterPill
            key={s}
            href={`/super/subscriptions?status=${s}`}
            active={status === s}
          >
            {s}
          </FilterPill>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No subscriptions"
          description={
            status
              ? `No subscriptions with status "${status}".`
              : "No subscriptions on this instance yet."
          }
        />
      ) : (
        <div className="table-card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Owner</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Provider</th>
                <th>Period</th>
                <th>Renews</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link
                      href={`/super/workspaces/${r.workspaceId}`}
                      className="text-ink hover:underline"
                    >
                      {r.workspaceName}
                    </Link>
                    <div className="text-xs text-mid mono">/{r.workspaceSlug}</div>
                  </td>
                  <td className="text-sm text-mid">{r.ownerEmail ?? "—"}</td>
                  <td>
                    <Badge tone="accent">{r.planCode}</Badge>
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.cancelAtPeriodEnd && (
                      <Badge tone="warn" className="ml-1">
                        cancels
                      </Badge>
                    )}
                  </td>
                  <td>
                    <Badge tone="neutral">{r.provider}</Badge>
                  </td>
                  <td className="text-xs text-mid">{r.billingPeriod}</td>
                  <td className="text-xs text-mid">
                    {r.currentPeriodEnd.toLocaleDateString()}
                  </td>
                  <td className="text-xs text-mid">
                    {r.createdAt.toLocaleDateString()}
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

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={[
        "rounded px-2 py-1 text-xs",
        active
          ? "bg-[var(--surface-3)] text-ink"
          : "text-mid hover:text-ink hover:bg-[var(--surface-2)]",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}
