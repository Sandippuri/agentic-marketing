"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BRAND_MEMORY_SLUGS,
  BRAND_MEMORY_TITLES,
  DESIGN_COLOR_ROLES,
  type BrandDocStatus,
  type BrandMemorySlug,
  type DesignColor,
  type DesignColorRole,
  type DesignTokens,
  type DesignTypography,
} from "@marketing/shared-types";

export type BrandDocRow = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: BrandDocStatus;
  pageCount: number | null;
  uploadedAt: string;
};

type DraftSlugBody = Record<BrandMemorySlug, string>;

type ExtractDrafts = {
  voice: string;
  icp: string;
  visual: string;
  productState: string;
  productPositioning: string;
  design: {
    colors: DesignColor[];
    typography: DesignTypography;
    tokens: DesignTokens;
  };
};

type ExtractResponse = {
  drafts: ExtractDrafts;
  sourceDocIds: string[];
  model: string;
};

const SLUG_FROM_DRAFT_KEY: Record<keyof Omit<ExtractDrafts, "design">, BrandMemorySlug> = {
  voice: "brand.voice",
  icp: "brand.icp",
  visual: "brand.visual",
  productState: "product.state",
  productPositioning: "product.positioning",
};

const ACCEPT =
  ".pdf,.docx,.md,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function statusTone(status: BrandDocStatus): string {
  switch (status) {
    case "embedded":
      return "var(--success)";
    case "failed":
      return "var(--danger)";
    case "removed":
      return "var(--text-faint)";
    default:
      return "var(--warn)";
  }
}

export function DocumentsForm({ initialDocs }: { initialDocs: BrandDocRow[] }) {
  const [docs, setDocs] = useState<BrandDocRow[]>(initialDocs);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length === 0) return;

    setError(null);
    setUploading(true);
    const form = new FormData();
    for (const file of arr) form.append("file", file);

    try {
      const res = await fetch("/api/brand-documents", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          filename?: string;
        };
        throw new Error(
          err.filename
            ? `${err.error ?? "upload_failed"}: ${err.filename}`
            : (err.error ?? `Upload failed (${res.status})`),
        );
      }
      const created = (await res.json()) as BrandDocRow[];
      setDocs((prev) => [
        ...created.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) })),
        ...prev,
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeDoc(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/brand-documents/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(err.error ?? `Delete failed (${res.status})`);
        }
        setDocs((prev) => prev.filter((d) => d.id !== id));
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  function onDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
  }

  return (
    <div className="space-y-5">
      <label
        htmlFor="brand-doc-upload"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={[
          "surface block cursor-pointer p-8 text-center transition-colors",
          dragOver
            ? "border-[var(--accent)] bg-[var(--surface-2)]"
            : "border-dashed",
          uploading ? "opacity-60 pointer-events-none" : "",
        ].join(" ")}
        style={{ borderStyle: dragOver ? "solid" : "dashed" }}
      >
        <input
          ref={fileInputRef}
          id="brand-doc-upload"
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
          }}
        />
        <div className="text-sm font-semibold text-ink">
          {uploading ? "Uploading…" : "Drop files here or click to upload"}
        </div>
        <div className="mt-1 text-xs text-mid">
          PDF, DOCX, MD, TXT — up to 25 MB each, 10 files per upload
        </div>
      </label>

      {error && <p className="text-sm text-[var(--danger)]">Error: {error}</p>}

      {docs.length === 0 ? (
        <div className="surface p-10 flex flex-col items-center text-center">
          <div className="text-sm font-semibold text-ink">No documents yet</div>
          <div className="mt-1 text-sm text-mid max-w-sm">
            Upload your brand book, product overview, customer stories, or any
            other source you want the agents to learn from.
          </div>
        </div>
      ) : (
        <ul className="surface divide-y divide-[var(--border)]">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink truncate">
                  {doc.filename}
                </div>
                <div className="mt-0.5 text-[11px] text-mid mono">
                  {formatBytes(doc.sizeBytes)} · uploaded {formatDate(doc.uploadedAt)}
                  {doc.pageCount != null ? ` · ${doc.pageCount} pages` : ""}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span
                  className="text-[11px] mono uppercase tracking-wider"
                  style={{ color: statusTone(doc.status) }}
                >
                  {doc.status}
                </span>
                <button
                  onClick={() => removeDoc(doc.id)}
                  disabled={isPending}
                  className="btn btn-sm"
                  aria-label={`Remove ${doc.filename}`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <GenerateBlock enabled={docs.length > 0} />
    </div>
  );
}

function GenerateBlock({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ExtractDrafts | null>(null);
  const [model, setModel] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/brand-extract", { method: "POST" });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
          filenames?: string[];
        };
        const detail =
          err.message ??
          (err.filenames?.length ? err.filenames.join(", ") : null) ??
          err.error ??
          `Generation failed (${res.status})`;
        throw new Error(detail);
      }
      const data = (await res.json()) as ExtractResponse;
      setDrafts(data.drafts);
      setModel(data.model);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 surface p-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink inline-flex items-center gap-2">
            <Sparkle />
            Generate brand content with AI
          </div>
          <p className="mt-0.5 text-xs text-mid">
            {enabled
              ? "Distill the corpus above into draft brand-memory bodies and design tokens. You'll review each draft before anything is saved."
              : "Upload at least one source document above to enable AI generation."}
          </p>
          {error && (
            <p className="mt-2 text-xs text-[var(--danger)]">Error: {error}</p>
          )}
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={!enabled || generating}
          className="btn btn-primary btn-sm shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {generating ? "Generating…" : "Generate"}
        </button>
      </div>

      {drafts && (
        <ReviewModal
          drafts={drafts}
          model={model}
          onClose={() => setDrafts(null)}
          onSaved={() => {
            setDrafts(null);
            // Re-fetch the server component so brand memory + design system
            // sections render the fresh values without a full reload.
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function ReviewModal({
  drafts,
  model,
  onClose,
  onSaved,
}: {
  drafts: ExtractDrafts;
  model: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [bodies, setBodies] = useState<DraftSlugBody>({
    "brand.voice": drafts.voice,
    "brand.icp": drafts.icp,
    "brand.visual": drafts.visual,
    "product.state": drafts.productState,
    "product.positioning": drafts.productPositioning,
    // Market context is human-authored on the Brand page; extraction
    // doesn't draft it, so we never overwrite an existing value here.
    "market.context": "",
  });
  const [colors, setColors] = useState<DesignColor[]>(drafts.design.colors);
  const [typography, setTypography] = useState<DesignTypography>(
    drafts.design.typography,
  );
  const [tokens, setTokens] = useState<DesignTokens>(drafts.design.tokens);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function confirm() {
    setSaveError(null);
    setSaving(true);
    try {
      // Brand-memory PUTs in parallel — each route is independent.
      // Skip market.context: extraction never produces a draft for it, so
      // saving here would clobber whatever the user wrote on the Brand page.
      const extractedSlugs = BRAND_MEMORY_SLUGS.filter((s) => s !== "market.context");
      await Promise.all(
        extractedSlugs.map(async (slug) => {
          const res = await fetch(
            `/api/brand-memory/${encodeURIComponent(slug)}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: BRAND_MEMORY_TITLES[slug],
                body: bodies[slug],
              }),
            },
          );
          if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(err.error ?? `Save failed for ${slug} (${res.status})`);
          }
        }),
      );

      // Design system: GET current to keep logos as-is, then PUT a merge.
      const dsRes = await fetch("/api/brand-design-system");
      if (!dsRes.ok) {
        throw new Error(`Could not read existing design system (${dsRes.status})`);
      }
      const current = (await dsRes.json()) as {
        logos: Array<{ variant: string; storagePath: string; contentType?: string; notes?: string }>;
      };
      const dsPut = await fetch("/api/brand-design-system", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          colors,
          typography,
          // Logos are uploaded separately and aren't produced by the
          // extractor — preserve whatever's already there.
          logos: current.logos.map((l) => ({
            variant: l.variant,
            storagePath: l.storagePath,
            contentType: l.contentType,
            notes: l.notes,
          })),
          tokens,
        }),
      });
      if (!dsPut.ok) {
        const err = (await dsPut.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Design system save failed (${dsPut.status})`);
      }
      onSaved();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="surface w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 rounded-lg shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-ink">
              Review AI-generated brand drafts
            </h2>
            <p className="mt-0.5 text-xs text-mid">
              Edit anything you want, then confirm to save. Each section is
              applied independently to brand memory and the design system.
            </p>
            {model && (
              <p className="mt-1 text-[11px] text-mid mono">model: {model}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn btn-ghost btn-sm shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5">
          {BRAND_MEMORY_SLUGS.filter((s) => s !== "market.context").map((slug) => (
            <DraftSection
              key={slug}
              title={BRAND_MEMORY_TITLES[slug]}
              slug={slug}
              value={bodies[slug]}
              onChange={(v) => setBodies((b) => ({ ...b, [slug]: v }))}
            />
          ))}

          <ColorsSection colors={colors} onChange={setColors} />

          <TypographySection
            typography={typography}
            onChange={setTypography}
          />

          <TokensSection tokens={tokens} onChange={setTokens} />
        </div>

        {saveError && (
          <p className="mt-4 text-sm text-[var(--danger)]">Error: {saveError}</p>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={saving}
            className="btn btn-primary btn-sm"
          >
            {saving ? "Saving…" : "Confirm & save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DraftSection({
  title,
  slug,
  value,
  onChange,
}: {
  title: string;
  slug: BrandMemorySlug;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <section className="surface-2 p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span className="text-[11px] text-mid mono">{slug}</span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.min(20, Math.max(6, value.split("\n").length + 1))}
        className="field w-full font-mono text-[12px] leading-relaxed"
      />
    </section>
  );
}

function ColorsSection({
  colors,
  onChange,
}: {
  colors: DesignColor[];
  onChange: (next: DesignColor[]) => void;
}) {
  function update(i: number, patch: Partial<DesignColor>) {
    onChange(colors.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function remove(i: number) {
    onChange(colors.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...colors, { name: "", hex: "#000000" }]);
  }

  return (
    <section className="surface-2 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-ink">Palette</h3>
        <span className="text-[11px] text-mid mono">design.colors</span>
      </div>
      {colors.length === 0 && (
        <p className="text-xs text-mid mb-3">
          The model didn't extract any colors. Add manually or skip.
        </p>
      )}
      <div className="space-y-2">
        {colors.map((c, i) => (
          <div
            key={i}
            className="grid grid-cols-[auto_1fr_1fr_auto_auto] items-center gap-2"
          >
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : "#000000"}
              onChange={(e) => update(i, { hex: e.target.value })}
              className="h-8 w-10 rounded border border-[var(--border)] bg-transparent"
              aria-label="Hex color"
            />
            <input
              type="text"
              value={c.name}
              placeholder="Name (e.g. Veru blue)"
              onChange={(e) => update(i, { name: e.target.value })}
              className="field field-sm"
            />
            <input
              type="text"
              value={c.hex}
              placeholder="#RRGGBB"
              onChange={(e) => update(i, { hex: e.target.value })}
              className="field field-sm font-mono"
            />
            <select
              value={c.role ?? ""}
              onChange={(e) =>
                update(i, {
                  role: e.target.value
                    ? (e.target.value as DesignColorRole)
                    : undefined,
                })
              }
              className="field field-sm"
            >
              <option value="">role…</option>
              {DESIGN_COLOR_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => remove(i)}
              className="btn btn-ghost btn-xs"
              aria-label="Remove color"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={add} className="mt-3 btn btn-sm">
        + Add color
      </button>
    </section>
  );
}

function TypographySection({
  typography,
  onChange,
}: {
  typography: DesignTypography;
  onChange: (next: DesignTypography) => void;
}) {
  function field<K extends keyof DesignTypography>(key: K, value: DesignTypography[K]) {
    onChange({ ...typography, [key]: value });
  }

  return (
    <section className="surface-2 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-ink">Typography</h3>
        <span className="text-[11px] text-mid mono">design.typography</span>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-3">
        <label className="text-xs text-mid flex flex-col gap-1">
          Heading family
          <input
            value={typography.headingFamily ?? ""}
            onChange={(e) => field("headingFamily", e.target.value || undefined)}
            className="field field-sm"
          />
        </label>
        <label className="text-xs text-mid flex flex-col gap-1">
          Body family
          <input
            value={typography.bodyFamily ?? ""}
            onChange={(e) => field("bodyFamily", e.target.value || undefined)}
            className="field field-sm"
          />
        </label>
        <label className="text-xs text-mid flex flex-col gap-1">
          Mono family
          <input
            value={typography.monoFamily ?? ""}
            onChange={(e) => field("monoFamily", e.target.value || undefined)}
            className="field field-sm"
          />
        </label>
      </div>
      <label className="text-xs text-mid flex flex-col gap-1 mt-2.5">
        Notes
        <textarea
          value={typography.notes ?? ""}
          onChange={(e) => field("notes", e.target.value || undefined)}
          rows={2}
          className="field text-[12px]"
        />
      </label>
    </section>
  );
}

function TokensSection({
  tokens,
  onChange,
}: {
  tokens: DesignTokens;
  onChange: (next: DesignTokens) => void;
}) {
  function field<K extends keyof DesignTokens>(key: K, value: DesignTokens[K]) {
    onChange({ ...tokens, [key]: value });
  }
  const fields: { key: keyof DesignTokens; label: string }[] = [
    { key: "spacing", label: "Spacing" },
    { key: "radii", label: "Radius" },
    { key: "shadows", label: "Shadows" },
    { key: "iconography", label: "Iconography" },
    { key: "notes", label: "Notes" },
  ];
  return (
    <section className="surface-2 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-ink">Tokens</h3>
        <span className="text-[11px] text-mid mono">design.tokens</span>
      </div>
      <div className="space-y-2.5">
        {fields.map((f) => (
          <label key={f.key} className="text-xs text-mid flex flex-col gap-1">
            {f.label}
            <textarea
              value={tokens[f.key] ?? ""}
              onChange={(e) => field(f.key, e.target.value || undefined)}
              rows={2}
              className="field text-[12px]"
            />
          </label>
        ))}
      </div>
    </section>
  );
}

function Sparkle() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[var(--accent)]"
    >
      <path d="M12 3l1.8 4.7L18 9.5l-4.2 1.8L12 16l-1.8-4.7L6 9.5l4.2-1.8L12 3z" />
      <path d="M19 14l.9 2.3L22 17l-2.1.7L19 20l-.9-2.3L16 17l2.1-.7L19 14z" />
    </svg>
  );
}
