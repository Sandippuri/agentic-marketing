"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { filterCommands } from "./slash-commands";

type UseSlashSuggestArgs = {
  input: string;
  onPick: (text: string) => void;
};

export function useSlashSuggest({ input, onPick }: UseSlashSuggestArgs) {
  const matches = filterCommands(input);
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
  }, [input]);

  const open = matches.length > 0;

  const handleKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % matches.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + matches.length) % matches.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const pick = matches[active] ?? matches[0]!;
      onPick(pick.insertText);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setActive(0);
      return true;
    }
    return false;
  };

  const popup = open ? (
    <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg overflow-hidden z-10">
      <ul className="max-h-64 overflow-y-auto text-sm">
        {matches.map((cmd, i) => (
          <li
            key={cmd.name}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(cmd.insertText);
            }}
            className={`px-3 py-2 cursor-pointer ${
              i === active
                ? "bg-indigo-50 dark:bg-indigo-950"
                : "bg-transparent"
            }`}
          >
            <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100">
              {cmd.usage}
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {cmd.description}
            </div>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return { popup, handleKeyDown };
}
