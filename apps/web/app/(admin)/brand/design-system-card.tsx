"use client";

import { useState } from "react";
import {
  DesignSystemForm,
  type InitialDesignSystem,
  type LogoWithSignedUrl,
} from "./design-system-form";
import type {
  DesignColor,
  DesignTypography,
} from "@marketing/shared-types";

export function DesignSystemCard({ initial }: { initial: InitialDesignSystem }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="surface overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-4 px-5 py-3 text-left hover:bg-[var(--surface-2)] transition-colors"
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                hasContent(initial)
                  ? "bg-[var(--success)]"
                  : "bg-[var(--warn)]"
              }`}
            />
            <h3 className="text-sm font-semibold text-ink">Design system</h3>
            <span className="text-[11px] mono text-faint">
              {summaryCounts(initial)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <ColorRow colors={initial.colors} />
            <TypeSample typography={initial.typography} />
            <LogoStrip logos={initial.logos} />
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 text-[11px] text-low">
          <span className="hidden sm:inline">
            {initial.updatedAt
              ? `last saved ${new Date(initial.updatedAt).toLocaleString()}`
              : "never saved"}
          </span>
          <Chevron open={open} />
        </div>
      </button>

      {open && (
        <div className="px-5 pb-5 pt-4 border-t border-[var(--border)]">
          <DesignSystemForm initial={initial} />
        </div>
      )}
    </section>
  );
}

function hasContent(s: InitialDesignSystem): boolean {
  return (
    s.colors.length > 0 ||
    s.logos.length > 0 ||
    !!s.typography.headingFamily ||
    !!s.typography.bodyFamily
  );
}

function summaryCounts(s: InitialDesignSystem): string {
  const parts: string[] = [];
  parts.push(`${s.colors.length} color${s.colors.length === 1 ? "" : "s"}`);
  parts.push(`${s.logos.length} logo${s.logos.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function ColorRow({ colors }: { colors: DesignColor[] }) {
  if (colors.length === 0) {
    return <span className="text-[11px] text-faint">no palette</span>;
  }
  return (
    <div className="flex items-center gap-1">
      {colors.slice(0, 6).map((c, i) => (
        <span
          key={i}
          className="h-4 w-4 rounded-sm border border-[var(--border)]"
          style={{ background: c.hex }}
          title={`${c.name || c.hex} ${c.role ? `· ${c.role}` : ""}`}
        />
      ))}
      {colors.length > 6 && (
        <span className="text-[11px] text-faint ml-1">+{colors.length - 6}</span>
      )}
    </div>
  );
}

function TypeSample({ typography }: { typography: DesignTypography }) {
  const family =
    typography.headingFamily || typography.bodyFamily || "no typeface";
  return (
    <span
      className="text-[11px] text-mid truncate max-w-[160px]"
      style={
        typography.headingFamily
          ? { fontFamily: typography.headingFamily }
          : undefined
      }
      title={family}
    >
      Aa · {family}
    </span>
  );
}

function LogoStrip({ logos }: { logos: LogoWithSignedUrl[] }) {
  if (logos.length === 0) {
    return <span className="text-[11px] text-faint">no logos</span>;
  }
  return (
    <div className="flex items-center gap-1">
      {logos.slice(0, 3).map((logo, i) => (
        <span
          key={i}
          className="h-5 w-7 rounded-sm border border-[var(--border)] bg-[var(--surface-2)] flex items-center justify-center overflow-hidden"
          title={`${logo.variant}${logo.notes ? ` — ${logo.notes}` : ""}`}
        >
          {logo.signedUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo.signedUrl}
              alt={logo.variant}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-[8px] text-faint mono">?</span>
          )}
        </span>
      ))}
      {logos.length > 3 && (
        <span className="text-[11px] text-faint ml-1">+{logos.length - 3}</span>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
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
      className={`transition-transform ${open ? "rotate-180" : ""}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
