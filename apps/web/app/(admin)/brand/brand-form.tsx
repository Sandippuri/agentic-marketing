"use client";

import { useState, useTransition } from "react";
import type { BrandMemorySlug } from "@marketing/shared-types";

export type BrandDoc = {
  slug: BrandMemorySlug;
  title: string;
  description: string;
  body: string;
  updatedAt: string | null;
};

type SaveResponse = {
  slug: BrandMemorySlug;
  title: string;
  body: string;
  updatedAt: string | null;
};

async function putBrandDoc(slug: BrandMemorySlug, body: string): Promise<SaveResponse> {
  const res = await fetch(`/api/brand-memory/${encodeURIComponent(slug)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `PUT /api/brand-memory/${slug} → ${res.status}`);
  }
  return res.json() as Promise<SaveResponse>;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "never saved";
  return `last saved ${new Date(iso).toLocaleString()}`;
}

function preview(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "Empty — click to add content.";
  const firstLine = trimmed.split("\n")[0]!.replace(/^#+\s*/, "");
  return firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine;
}

export function BrandForm({ initialDocs }: { initialDocs: BrandDoc[] }) {
  const [docs, setDocs] = useState<BrandDoc[]>(initialDocs);
  const [openSlug, setOpenSlug] = useState<BrandMemorySlug | null>(null);
  const [savingSlug, setSavingSlug] = useState<BrandMemorySlug | null>(null);
  const [savedSlug, setSavedSlug] = useState<BrandMemorySlug | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle(slug: BrandMemorySlug) {
    setSavedSlug(null);
    setOpenSlug((prev) => (prev === slug ? null : slug));
  }

  function updateBody(slug: BrandMemorySlug, body: string) {
    setSavedSlug(null);
    setDocs((prev) => prev.map((d) => (d.slug === slug ? { ...d, body } : d)));
  }

  function save(slug: BrandMemorySlug) {
    const doc = docs.find((d) => d.slug === slug);
    if (!doc) return;
    setError(null);
    setSavedSlug(null);
    setSavingSlug(slug);
    startTransition(async () => {
      try {
        const next = await putBrandDoc(slug, doc.body);
        setDocs((prev) =>
          prev.map((d) =>
            d.slug === slug
              ? { ...d, body: next.body, title: next.title, updatedAt: next.updatedAt }
              : d,
          ),
        );
        setSavedSlug(slug);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSavingSlug(null);
      }
    });
  }

  return (
    <div className="space-y-2">
      {docs.map((doc) => {
        const open = openSlug === doc.slug;
        const filled = doc.body.trim().length > 0;
        return (
          <section key={doc.slug} className="surface overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(doc.slug)}
              className="w-full flex items-center justify-between gap-4 px-5 py-3 text-left hover:bg-[var(--surface-2)] transition-colors"
              aria-expanded={open}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                      filled ? "bg-[var(--success)]" : "bg-[var(--warn)]"
                    }`}
                  />
                  <h3 className="text-sm font-semibold text-ink">{doc.title}</h3>
                  <span className="text-[11px] mono text-faint">{doc.slug}</span>
                </div>
                <p className="mt-0.5 text-xs text-mid truncate">{preview(doc.body)}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0 text-[11px] text-low">
                <span className="hidden sm:inline">{formatTimestamp(doc.updatedAt)}</span>
                <Chevron open={open} />
              </div>
            </button>

            {open && (
              <div className="px-5 pb-5 pt-1 border-t border-[var(--border)]">
                <p className="text-sm text-mid mb-3">{doc.description}</p>
                <textarea
                  value={doc.body}
                  onChange={(e) => updateBody(doc.slug, e.target.value)}
                  rows={12}
                  spellCheck={false}
                  className="field mono text-[13px] leading-relaxed"
                  placeholder="Markdown content. Use ## for section headings."
                />
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={() => save(doc.slug)}
                    disabled={isPending && savingSlug === doc.slug}
                    className="btn btn-primary btn-sm"
                  >
                    {savingSlug === doc.slug ? "Saving…" : "Save"}
                  </button>
                  {savedSlug === doc.slug && (
                    <span className="text-sm text-[var(--success)] inline-flex items-center gap-1">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                      Saved
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>
        );
      })}

      {error && (
        <p className="text-sm text-[var(--danger)]">Error: {error}</p>
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
