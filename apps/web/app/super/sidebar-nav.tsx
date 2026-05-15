"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type SuperNavItem = { href: string; label: string; badge?: number };
export type SuperNavSection = { label: string; items: SuperNavItem[] };

export function SuperSidebarNav({ sections }: { sections: SuperNavSection[] }) {
  const pathname = usePathname() ?? "";

  return (
    <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-5">
      {sections.map((section) => (
        <div key={section.label}>
          <div className="px-2 mb-1.5 section-title">{section.label}</div>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active =
                pathname === item.href ||
                (item.href !== "/super" && pathname.startsWith(item.href + "/")) ||
                (item.href === "/super" && pathname === "/super");
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={[
                      "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                      active
                        ? "bg-[var(--surface-2)] text-ink"
                        : "text-mid hover:text-ink hover:bg-[var(--surface-2)]",
                    ].join(" ")}
                  >
                    <span className="flex-1 truncate">{item.label}</span>
                    {typeof item.badge === "number" && item.badge > 0 && (
                      <span className="ml-1 rounded-full bg-[var(--accent)] text-white text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px] text-center">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
