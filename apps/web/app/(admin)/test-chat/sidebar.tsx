"use client";

// Threads sidebar — search box + date-grouped list + per-row actions
// (rename inline, delete with two-click confirm) + relative timestamps.
//
// Threads live in localStorage; this component is dumb wrt persistence — it
// just renders + emits callbacks. The host (chat-client-ready) owns the
// state and writes to storage.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export type SidebarThread = {
  id: string;
  threadRef: string;
  label: string;
  createdAt: number;
};

type Group = { key: string; label: string; threads: SidebarThread[] };

export function Sidebar({
  threads,
  activeId,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: {
  threads: SidebarThread[];
  activeId: string;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, newLabel: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!trimmed) return threads;
    return threads.filter((t) => t.label.toLowerCase().includes(trimmed));
  }, [threads, trimmed]);

  const groups = useMemo<Group[]>(() => groupByDate(filtered), [filtered]);

  return (
    <aside className="flex flex-col gap-2 min-h-0">
      <button
        onClick={onNew}
        className="rounded-lg bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 text-white text-sm font-medium px-3 py-2"
      >
        + New chat
      </button>
      <div className="relative">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 pl-7 text-xs placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-800 dark:bg-zinc-900 dark:placeholder:text-zinc-500"
        />
        <SearchIcon />
      </div>
      <ul className="flex-1 overflow-y-auto pr-0.5">
        {filtered.length === 0 ? (
          <li className="px-2 py-3 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
            {trimmed ? "No matches" : "No chats yet"}
          </li>
        ) : (
          groups.map((g) => (
            <li key={g.key} className="mb-2">
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                {g.label}
              </div>
              <ul className="space-y-0.5">
                {g.threads.map((t) => (
                  <Row
                    key={t.id}
                    thread={t}
                    active={t.id === activeId}
                    onSelect={() => onSelect(t.id)}
                    onRename={(label) => onRename(t.id, label)}
                    onDelete={() => onDelete(t.id)}
                  />
                ))}
              </ul>
            </li>
          ))
        )}
      </ul>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Row — single thread; supports inline rename and two-click delete
// ─────────────────────────────────────────────────────────────────────────

function Row({
  thread,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  thread: SidebarThread;
  active: boolean;
  onSelect: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(thread.label);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus + select the label when rename starts. Cancels if the row
  // becomes inactive while editing (e.g. user clicks a different chat).
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);
  useEffect(() => {
    if (!active && renaming) setRenaming(false);
  }, [active, renaming]);
  useEffect(() => {
    if (!active && confirmingDelete) setConfirmingDelete(false);
  }, [active, confirmingDelete]);

  const commitRename = () => {
    const next = draft.trim();
    if (next && next !== thread.label) onRename(next);
    setRenaming(false);
  };

  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(thread.label);
      setRenaming(false);
    }
  };

  if (renaming) {
    return (
      <li>
        <div className="flex items-center gap-1 rounded-md bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onRenameKey}
            onBlur={commitRename}
            className="w-full rounded bg-transparent px-1 py-0.5 text-xs text-zinc-900 focus:outline-none dark:text-zinc-100"
            maxLength={80}
          />
        </div>
      </li>
    );
  }

  if (confirmingDelete) {
    return (
      <li>
        <div className="flex items-center justify-between gap-1 rounded-md bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
          <span className="truncate">Delete this chat?</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="rounded bg-rose-600 px-1.5 py-0.5 text-white hover:bg-rose-500"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(false);
              }}
              className="rounded px-1.5 py-0.5 text-rose-700 hover:bg-rose-100 dark:text-rose-200 dark:hover:bg-rose-900/60"
            >
              No
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="group">
      <div
        className={`flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-xs ${
          active
            ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
            : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        }`}
      >
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={() => setRenaming(true)}
          className="flex-1 truncate text-left"
          title={`${thread.threadRef}\n${new Date(thread.createdAt || 0).toLocaleString()}`}
        >
          <div className="truncate">{thread.label}</div>
          <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
            {formatRelative(thread.createdAt)}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <IconButton
            label="Rename"
            onClick={(e) => {
              e.stopPropagation();
              setDraft(thread.label);
              setRenaming(true);
            }}
          >
            <PencilIcon />
          </IconButton>
          <IconButton
            label="Delete"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(true);
            }}
            danger
          >
            <TrashIcon />
          </IconButton>
        </div>
      </div>
    </li>
  );
}

function IconButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700 ${
        danger ? "hover:text-rose-600 dark:hover:text-rose-400" : "hover:text-zinc-900 dark:hover:text-zinc-100"
      }`}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Date grouping + relative timestamp
//
// Groups: Today / Yesterday / Previous 7 days / This month / Earlier.
// Threads are ordered most-recent-first within each group; createdAt=0
// (legacy threads without the field) lands in Earlier.
// ─────────────────────────────────────────────────────────────────────────

function groupByDate(threads: SidebarThread[]): Group[] {
  const now = new Date();
  const startOfToday = startOfDay(now).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000; // last 7 days incl today
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
  ).getTime();

  const buckets: Record<string, SidebarThread[]> = {
    today: [],
    yesterday: [],
    week: [],
    month: [],
    earlier: [],
  };

  for (const t of threads) {
    const c = t.createdAt || 0;
    if (c >= startOfToday) buckets.today!.push(t);
    else if (c >= startOfYesterday) buckets.yesterday!.push(t);
    else if (c >= startOfWeek) buckets.week!.push(t);
    else if (c >= startOfMonth) buckets.month!.push(t);
    else buckets.earlier!.push(t);
  }

  const out: Group[] = [];
  const pushIf = (key: string, label: string) => {
    const list = buckets[key]!;
    if (list.length === 0) return;
    list.sort((a, b) => b.createdAt - a.createdAt);
    out.push({ key, label, threads: list });
  };
  pushIf("today", "Today");
  pushIf("yesterday", "Yesterday");
  pushIf("week", "Previous 7 days");
  pushIf("month", "This month");
  pushIf("earlier", "Earlier");
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function formatRelative(ts: number): string {
  if (!ts) return "earlier";
  const now = Date.now();
  const diff = now - ts;
  const m = Math.round(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(diff / (60 * 60_000));
  if (h < 24) return `${h}h ago`;
  const d = Math.round(diff / (24 * 60 * 60_000));
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
