"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

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
  const [openId, setOpenId] = useState<string | null>(null);

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

  const activeFilterCount =
    Number(!!filters.actor) +
    Number(!!filters.action) +
    Number(!!filters.entity) +
    Number(!!filters.from) +
    Number(!!filters.to);

  return (
    <div>
      {/* Filter bar */}
      <div className="surface mb-5 px-3 py-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">Filter</span>

        <select
          value={filters.actor}
          onChange={(e) => updateFilter("actor", e.target.value)}
          className="field field-sm w-[120px]"
        >
          <option value="">All actors</option>
          <option value="human">Human</option>
          <option value="agent">Agent</option>
          <option value="system">System</option>
        </select>

        <select
          value={filters.action}
          onChange={(e) => updateFilter("action", e.target.value)}
          className="field field-sm w-[180px]"
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={filters.entity}
          onChange={(e) => updateFilter("entity", e.target.value)}
          placeholder="Entity type"
          className="field field-sm w-[140px]"
        />

        <span className="h-5 w-px bg-[var(--border)] mx-1" />

        <input
          type="date"
          value={filters.from}
          onChange={(e) => updateFilter("from", e.target.value)}
          className="field field-sm w-[150px]"
        />
        <span className="text-faint text-xs">→</span>
        <input
          type="date"
          value={filters.to}
          onChange={(e) => updateFilter("to", e.target.value)}
          className="field field-sm w-[150px]"
        />

        <div className="ml-auto flex items-center gap-2">
          {activeFilterCount > 0 && (
            <span className="text-[11px] text-mid">
              {activeFilterCount} active
            </span>
          )}
          <button
            onClick={() => router.push(pathname)}
            className="btn btn-ghost btn-sm"
            disabled={activeFilterCount === 0}
          >
            Reset
          </button>
        </div>
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div className="surface p-10 text-center">
          <div className="text-sm font-medium text-ink">No entries</div>
          <p className="mt-1 text-xs text-mid">
            Try widening the date range or clearing filters.
          </p>
        </div>
      ) : (
        <div className="table-card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "180px" }}>When</th>
                <th style={{ width: "100px" }}>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th style={{ width: "140px" }}>Changes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = openId === r.id;
                const hasDiff = r.before !== null || r.after !== null;
                return (
                  <>
                    <tr key={r.id}>
                      <td className="mono text-xs text-mid whitespace-nowrap">
                        {formatTime(r.at)}
                      </td>
                      <td>
                        <ActorBadge kind={r.actorKind} />
                      </td>
                      <td className="mono text-[12.5px] text-ink">
                        {r.action}
                      </td>
                      <td className="mono text-xs text-mid">
                        <span>{r.entityType}</span>
                        {r.entityId && (
                          <span className="text-faint ml-1">
                            /{r.entityId.slice(0, 8)}
                          </span>
                        )}
                      </td>
                      <td>
                        {hasDiff ? (
                          <button
                            onClick={() => setOpenId(isOpen ? null : r.id)}
                            className="btn btn-ghost btn-xs"
                          >
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              style={{
                                transform: isOpen ? "rotate(90deg)" : "none",
                                transition: "transform 120ms",
                              }}
                            >
                              <path d="M9 18l6-6-6-6" />
                            </svg>
                            {isOpen ? "Hide diff" : "View diff"}
                          </button>
                        ) : (
                          <span className="text-faint text-xs">—</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && hasDiff && (
                      <tr key={r.id + ":diff"}>
                        <td colSpan={5} className="bg-[var(--surface-2)] !py-3">
                          <div className="grid grid-cols-2 gap-3">
                            <DiffPane label="Before" value={r.before} />
                            <DiffPane label="After" value={r.after} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between">
        <div className="text-xs text-mid">
          Page <span className="text-ink font-medium">{page}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => goPage(page - 1)}
            disabled={page <= 1}
            className="btn btn-secondary btn-sm"
          >
            ← Previous
          </button>
          <button
            onClick={() => goPage(page + 1)}
            disabled={!hasMore}
            className="btn btn-secondary btn-sm"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}

function ActorBadge({ kind }: { kind: string }) {
  const tone =
    kind === "human"
      ? "badge-info"
      : kind === "agent"
        ? "badge-violet"
        : "badge-neutral";
  return (
    <span className={`badge badge-dot ${tone}`}>
      {kind}
    </span>
  );
}

function DiffPane({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="section-title mb-1.5">{label}</div>
      <pre className="mono text-[11.5px] leading-snug surface p-3 max-h-72 overflow-auto whitespace-pre-wrap break-words">
        {value === null || value === undefined
          ? "—"
          : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${date} · ${time}`;
}
