"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

export function PublishJobFilters({
  channel,
  status,
  channels,
  statuses,
}: {
  channel: string;
  status: string;
  channels: string[];
  statuses: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const update = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`);
  };

  const hasFilters = !!(channel || status);

  return (
    <div className="surface mb-5 px-3 py-2.5 flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">
        Filter
      </span>
      <select
        value={channel}
        onChange={(e) => update("channel", e.target.value)}
        className="field field-sm w-42.5"
      >
        <option value="">All channels</option>
        {channels.map((c) => (
          <option key={c} value={c}>
            {c.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <select
        value={status}
        onChange={(e) => update("status", e.target.value)}
        className="field field-sm w-35"
      >
        <option value="">All statuses</option>
        {statuses.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {hasFilters && (
        <button
          onClick={() => router.push(pathname)}
          className="btn btn-ghost btn-sm ml-auto"
        >
          Reset
        </button>
      )}
    </div>
  );
}
