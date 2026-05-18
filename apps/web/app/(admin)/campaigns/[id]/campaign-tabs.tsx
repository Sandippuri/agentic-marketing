"use client";

import { useState, type ReactNode } from "react";

type TabKey = "brief" | "calendar" | "content" | "brand";

type Tab = {
  key: TabKey;
  label: string;
  count?: number;
  available: boolean;
  panel: ReactNode;
};

export function CampaignTabs({
  brief,
  calendar,
  content,
  brand,
  hasBrief,
  calendarCount,
  contentCount,
  partnerLogoCount,
}: {
  brief: ReactNode;
  calendar: ReactNode;
  content: ReactNode;
  brand: ReactNode;
  hasBrief: boolean;
  calendarCount: number;
  contentCount: number;
  partnerLogoCount: number;
}) {
  const tabs: Tab[] = [
    { key: "brief", label: "Brief", available: hasBrief, panel: brief },
    {
      key: "calendar",
      label: "Calendar",
      count: calendarCount,
      available: calendarCount > 0,
      panel: calendar,
    },
    {
      key: "content",
      label: "Content",
      count: contentCount,
      available: true,
      panel: content,
    },
    {
      key: "brand",
      label: "Brand",
      count: partnerLogoCount > 0 ? partnerLogoCount : undefined,
      available: true,
      panel: brand,
    },
  ];

  const firstAvailable = tabs.find((t) => t.available)?.key ?? "content";
  const [active, setActive] = useState<TabKey>(firstAvailable);

  return (
    <div>
      <div
        role="tablist"
        aria-label="Campaign sections"
        className="flex items-center gap-1 border-b border-[var(--border)] mb-5"
      >
        {tabs.map((tab) => {
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.key}`}
              id={`tab-${tab.key}`}
              disabled={!tab.available}
              onClick={() => tab.available && setActive(tab.key)}
              className={[
                "relative px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2",
                isActive
                  ? "text-ink border-[var(--accent)]"
                  : "text-mid border-transparent hover:text-ink",
                !tab.available && "opacity-40 cursor-not-allowed",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {tab.label}
              {typeof tab.count === "number" && (
                <span className="ml-2 text-xs text-faint mono">{tab.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.key}
          role="tabpanel"
          id={`tabpanel-${tab.key}`}
          aria-labelledby={`tab-${tab.key}`}
          hidden={active !== tab.key}
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
