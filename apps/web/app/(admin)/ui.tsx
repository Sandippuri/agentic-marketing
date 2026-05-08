import type { ReactNode, HTMLAttributes } from "react";

/* ============================================================
   Shared UI primitives for the admin dashboard.
   Server-component friendly. No client-only deps.
   ============================================================ */

export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-mid max-w-2xl">{description}</p>
        )}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

export function Card({
  children,
  className = "",
  padded = true,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div
      {...rest}
      className={`surface ${padded ? "p-5" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-mid">{description}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "accent" | "success" | "warn" | "danger";
}) {
  const toneClass =
    tone === "accent"
      ? "text-accent"
      : tone === "success"
        ? "text-[var(--success)]"
        : tone === "warn"
          ? "text-[var(--warn)]"
          : tone === "danger"
            ? "text-[var(--danger)]"
            : "text-ink";
  return (
    <div className="surface p-4">
      <div className="section-title">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tracking-tight ${toneClass}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-mid">{hint}</div>}
    </div>
  );
}

type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warn"
  | "danger"
  | "info"
  | "violet";

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={`badge badge-${tone} ${dot ? "badge-dot" : ""} ${className}`}>
      {children}
    </span>
  );
}

/** Map any free-form status string to a badge tone. */
export function statusTone(status: string | null | undefined): BadgeTone {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (["active", "succeeded", "approved", "published", "connected", "completed", "done"].includes(s)) return "success";
  if (["failed", "rejected", "error", "cancelled", "canceled", "missing", "not_connected"].includes(s)) return "danger";
  if (["paused", "needs_attention", "partial", "in_review", "queued", "pending", "warn"].includes(s)) return "warn";
  if (["running", "draft", "buildup", "info"].includes(s)) return "info";
  if (["launch", "violet", "agent"].includes(s)) return "violet";
  if (["post_launch", "archived"].includes(s)) return "neutral";
  return "neutral";
}

export function StatusBadge({
  status,
  label,
}: {
  status: string | null | undefined;
  label?: string;
}) {
  return (
    <Badge tone={statusTone(status)} dot>
      {label ?? status ?? "—"}
    </Badge>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="surface p-10 flex flex-col items-center text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <div className="text-sm font-semibold text-ink">{title}</div>
      {description && (
        <div className="mt-1 text-sm text-mid max-w-sm">{description}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="surface mb-5 flex flex-wrap items-center gap-2 px-3 py-2.5">
      {children}
    </div>
  );
}

export function ToolbarSeparator() {
  return <span className="h-5 w-px bg-[var(--border)] mx-1" />;
}

/** Display-only key-value row. */
export function KV({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 text-sm">
      <span className="text-mid w-32 shrink-0 text-xs uppercase tracking-wider">{label}</span>
      <span className="text-ink min-w-0">{children}</span>
    </div>
  );
}

/* Common tiny icons (no extra deps) */
export function Dot({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${className}`} />;
}
