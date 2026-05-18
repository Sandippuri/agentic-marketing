"use client";

// Centered greeting + composer + workflow chips, shown when the active thread
// has no messages yet. Picked the four most common starting actions; clicking
// a chip prefills the composer (or navigates, for Review approvals).
//
// Below the chips: an expandable "Type / for shortcuts" hint that lists the
// slash commands so users discover them without trial-and-error.

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { SLASH_COMMANDS } from "./slash-commands";

type ChipAction =
  | { kind: "prefill"; text: string }
  | { kind: "navigate"; href: string };

type Chip = {
  label: string;
  icon: ReactNode;
  action: ChipAction;
};

const CHIPS: Chip[] = [
  {
    label: "Plan a campaign",
    icon: <IconCompass />,
    action: { kind: "prefill", text: "Plan a campaign for " },
  },
  {
    label: "Draft a post",
    icon: <IconPen />,
    action: { kind: "prefill", text: "Draft a LinkedIn post about " },
  },
  {
    label: "Research a topic",
    icon: <IconSearch />,
    action: { kind: "prefill", text: "Research " },
  },
  {
    label: "Review approvals",
    icon: <IconCheck />,
    action: { kind: "navigate", href: "/approvals" },
  },
];

export function EmptyState({
  workspaceName,
  displayName,
  onPrefill,
}: {
  workspaceName?: string | null;
  displayName?: string | null;
  onPrefill: (text: string) => void;
}) {
  const router = useRouter();
  const firstName = (displayName ?? "").trim().split(/\s+/)[0] ?? "";
  const [showSlashHelp, setShowSlashHelp] = useState(false);

  return (
    <div className="flex h-full w-full items-center justify-center px-4">
      <div className="w-full max-w-2xl space-y-6">
        {workspaceName && (
          <div className="flex justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-indigo-100 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200">
                {workspaceName.slice(0, 1).toUpperCase()}
              </span>
              {workspaceName}
            </span>
          </div>
        )}
        <h2 className="text-center text-3xl font-medium tracking-tight text-zinc-900 dark:text-zinc-100">
          <span className="mr-2 text-indigo-500">✦</span>
          {firstName ? `Back at it, ${firstName}` : "What's on your mind?"}
        </h2>
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          {CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => {
                if (chip.action.kind === "prefill") {
                  onPrefill(chip.action.text);
                } else {
                  router.push(chip.action.href);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/60 dark:hover:text-indigo-200"
            >
              {chip.icon}
              {chip.label}
            </button>
          ))}
        </div>
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => setShowSlashHelp((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            aria-expanded={showSlashHelp}
          >
            <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[10px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              /
            </kbd>
            {showSlashHelp ? "Hide shortcuts" : "Type / for shortcuts"}
          </button>
        </div>
        {showSlashHelp && (
          <ul className="mx-auto grid max-w-md gap-1 rounded-lg border border-zinc-200 bg-white p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
            {SLASH_COMMANDS.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => onPrefill(c.usage.includes(" ") ? `${c.name} ` : c.name)}
                  className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <code className="font-mono text-indigo-600 dark:text-indigo-300">
                    {c.usage}
                  </code>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {c.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IconCompass() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}
function IconPen() {
  return (
    <svg
      width="14"
      height="14"
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
function IconSearch() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.801 10A10 10 0 1 1 17 3.335" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}
