"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

type AuditRow = {
  id: string;
  at: string;
  actorKind: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
};

type Filters = {
  actor: string;
  action: string;
  entity: string;
  from: string;
  to: string;
};

type Props = {
  rows: AuditRow[];
  actions: string[];
  page: number;
  hasMore: boolean;
  filters: Filters;
};

export function AuditLogTable({ rows, actions, page, hasMore, filters }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  const goPage = (p: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 mb-6">
        <select
          value={filters.actor}
          onChange={(e) => updateFilter("actor", e.target.value)}
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
        >
          <option value="">All actors</option>
          <option value="human">Human</option>
          <option value="agent">Agent</option>
          <option value="system">System</option>
        </select>

        <select
          value={filters.action}
          onChange={(e) => updateFilter("action", e.target.value)}
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <input
          type="text"
          value={filters.entity}
          onChange={(e) => updateFilter("entity", e.target.value)}
          placeholder="Entity type"
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm w-36"
        />

        <input
          type="date"
          value={filters.from}
          onChange={(e) => updateFilter("from", e.target.value)}
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
        />
        <span className="self-center text-zinc-400 text-sm">→</span>
        <input
          type="date"
          value={filters.to}
          onChange={(e) => updateFilter("to", e.target.value)}
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
        />

        <button
          onClick={() => router.push(pathname)}
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          Reset
        </button>
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <p className="text-zinc-500 text-sm">No entries match the current filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="py-2 pr-4 whitespace-nowrap">When</th>
                <th className="py-2 pr-4">Actor</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Entity</th>
                <th className="py-2">Changes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                    {new Date(r.at).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={[
                      "inline-block rounded px-1.5 py-0.5 text-xs font-medium",
                      r.actorKind === "human" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" :
                      r.actorKind === "agent" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300" :
                      "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
                    ].join(" ")}>
                      {r.actorKind}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.action}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {r.entityType}
                    {r.entityId && <span className="ml-1 text-zinc-400 dark:text-zinc-600">/{r.entityId.slice(0, 8)}</span>}
                  </td>
                  <td className="py-2 text-xs">
                    {(r.before !== null || r.after !== null) && (
                      <details>
                        <summary className="cursor-pointer text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                          diff
                        </summary>
                        <pre className="mt-1 text-xs bg-zinc-100 dark:bg-zinc-900 rounded p-2 overflow-x-auto max-w-xs">
                          {JSON.stringify({ before: r.before, after: r.after }, null, 2)}
                        </pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="mt-4 flex gap-2">
        {page > 1 && (
          <button
            onClick={() => goPage(page - 1)}
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            ← Previous
          </button>
        )}
        {hasMore && (
          <button
            onClick={() => goPage(page + 1)}
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 ml-auto"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}
