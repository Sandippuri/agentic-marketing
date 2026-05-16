"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = {
  href: string;
  label: string;
  icon?: string;
  badge?: number;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

export function SidebarNav({
  sections,
  pinned,
}: {
  sections: NavSection[];
  /** Items rendered above the labelled sections, with no section header. */
  pinned?: NavItem[];
}) {
  const pathname = usePathname() ?? "";

  const renderItem = (item: NavItem) => {
    const active =
      pathname === item.href || pathname.startsWith(item.href + "/");
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
          <span
            className={[
              "shrink-0 grid place-items-center h-5 w-5 rounded",
              active ? "text-[var(--accent)]" : "text-faint group-hover:text-mid",
            ].join(" ")}
          >
            <NavIcon name={item.icon} />
          </span>
          <span className="flex-1 truncate">{item.label}</span>
          {typeof item.badge === "number" && item.badge > 0 && (
            <span className="ml-1 rounded-full bg-[var(--accent)] text-white text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px] text-center">
              {item.badge}
            </span>
          )}
        </Link>
      </li>
    );
  };

  return (
    <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-5">
      {pinned && pinned.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {pinned.map((item) => renderItem(item))}
        </ul>
      )}
      {sections.map((section) => (
        <div key={section.label}>
          <div className="px-2 mb-1.5 section-title">{section.label}</div>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => renderItem(item))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function NavIcon({ name }: { name?: string }) {
  const stroke = 1.75;
  const props = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: stroke,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "campaigns":
      return (
        <svg {...props}>
          <path d="M3 11l18-7v16L3 13z" />
          <path d="M11.6 16.5L13 22l-4 1-2.5-7" />
        </svg>
      );
    case "workflow":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="6" height="6" rx="1" />
          <rect x="15" y="15" width="6" height="6" rx="1" />
          <path d="M9 6h6a3 3 0 013 3v6" />
        </svg>
      );
    case "approvals":
      return (
        <svg {...props}>
          <path d="M9 12l2 2 4-4" />
          <path d="M21 12c0 5-4 9-9 9s-9-4-9-9 4-9 9-9c2.5 0 4.7 1 6.4 2.6" />
        </svg>
      );
    case "publish":
      return (
        <svg {...props}>
          <path d="M22 2L11 13" />
          <path d="M22 2l-7 20-4-9-9-4 20-7z" />
        </svg>
      );
    case "gallery":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      );
    case "posts":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8M8 17h5" />
        </svg>
      );
    case "insights":
      return (
        <svg {...props}>
          <path d="M3 3v18h18" />
          <path d="M7 14l4-4 3 3 5-6" />
        </svg>
      );
    case "audit":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6M9 17h6" />
        </svg>
      );
    case "brand":
      return (
        <svg {...props}>
          <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
        </svg>
      );
    case "design":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="7" r="1.5" />
          <circle cx="7" cy="12" r="1.5" />
          <circle cx="17" cy="12" r="1.5" />
          <circle cx="12" cy="17" r="1.5" />
        </svg>
      );
    case "chat":
      return (
        <svg {...props}>
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      );
    case "plug":
      return (
        <svg {...props}>
          <path d="M9 2v6M15 2v6" />
          <path d="M5 8h14v3a7 7 0 01-14 0z" />
          <path d="M12 18v4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 005.5 15a1.65 1.65 0 00-1.51-1H4a2 2 0 110-4h.09A1.65 1.65 0 005.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 5.6 1.65 1.65 0 0010 4.09V4a2 2 0 114 0v.09c0 .67.39 1.27 1 1.51a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0018.4 9c.24.61.84 1 1.51 1H20a2 2 0 110 4h-.09c-.67 0-1.27.39-1.51 1z" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}
