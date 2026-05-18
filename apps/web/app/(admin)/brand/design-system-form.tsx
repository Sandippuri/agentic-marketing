"use client";

import { useState, useTransition } from "react";
import {
  DESIGN_COLOR_ROLES,
  DESIGN_LOGO_VARIANTS,
  type DesignColor,
  type DesignColorRole,
  type DesignLogo,
  type DesignLogoVariant,
  type DesignTokens,
  type DesignTypography,
} from "@marketing/shared-types";

export type LogoWithSignedUrl = DesignLogo & { signedUrl: string | null };

export type InitialDesignSystem = {
  colors: DesignColor[];
  typography: DesignTypography;
  logos: LogoWithSignedUrl[];
  tokens: DesignTokens;
  updatedAt: string | null;
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function formatTimestamp(iso: string | null): string {
  if (!iso) return "never saved";
  return `last saved ${new Date(iso).toLocaleString()}`;
}

export function DesignSystemForm({ initial }: { initial: InitialDesignSystem }) {
  const [colors, setColors] = useState<DesignColor[]>(initial.colors);
  const [typography, setTypography] = useState<DesignTypography>(initial.typography);
  const [logos, setLogos] = useState<LogoWithSignedUrl[]>(initial.logos);
  const [tokens, setTokens] = useState<DesignTokens>(initial.tokens);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial.updatedAt);

  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);

  function save() {
    setError(null);
    setSavedAt(null);

    // Strip the signedUrl before sending — the server doesn't store it.
    const payload = {
      colors,
      typography,
      logos: logos.map(({ signedUrl: _signedUrl, ...rest }) => rest),
      tokens,
    };

    startTransition(async () => {
      try {
        const res = await fetch("/api/brand-design-system", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `PUT /api/brand-design-system → ${res.status}`);
        }
        const next = await res.json();
        setColors(next.colors);
        setTypography(next.typography);
        setLogos(next.logos);
        setTokens(next.tokens);
        setUpdatedAt(next.updatedAt);
        setSavedAt(new Date().toISOString());
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  // Persist just the logos array — lets uploads/removals save immediately
  // without flushing unsaved edits to colors/typography/tokens.
  async function persistLogos(next: LogoWithSignedUrl[]) {
    const res = await fetch("/api/brand-design-system/logos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logos: next.map(({ signedUrl: _signedUrl, ...rest }) => rest),
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `persist logos → ${res.status}`);
    }
    const body = (await res.json()) as {
      logos: LogoWithSignedUrl[];
      updatedAt: string;
    };
    setLogos(body.logos);
    setUpdatedAt(body.updatedAt);
  }

  async function uploadLogo(file: File, variant: DesignLogoVariant) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/brand-design-system/logos", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `upload → ${res.status}`);
      }
      const json = (await res.json()) as {
        storagePath: string;
        contentType: string;
        signedUrl: string;
        // Vision-LLM-generated description of the mark (one line, ≤220 chars).
        // Used by the image-gen prompt as verbal grounding alongside the
        // attached file. Pre-fills the notes field so the user can edit.
        autoNotes?: string | null;
      };
      const next: LogoWithSignedUrl[] = [
        ...logos,
        {
          variant,
          storagePath: json.storagePath,
          contentType: json.contentType,
          signedUrl: json.signedUrl,
          notes: json.autoNotes ?? undefined,
        },
      ];
      await persistLogos(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function removeLogo(idx: number) {
    const logo = logos[idx];
    if (!logo) return;
    const next = logos.filter((_, i) => i !== idx);
    setError(null);
    try {
      await persistLogos(next);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    // Best-effort delete from storage after the DB row no longer references
    // the file. If this fails the object is orphaned but the DB stays clean.
    try {
      await fetch(
        `/api/brand-design-system/logos?path=${encodeURIComponent(logo.storagePath)}`,
        { method: "DELETE" },
      );
    } catch {
      // ignore.
    }
  }

  return (
    <div className="space-y-8">
      <ColorSection colors={colors} setColors={setColors} />
      <TypographySection typography={typography} setTypography={setTypography} />
      <LogoSection
        logos={logos}
        onUpload={uploadLogo}
        onRemove={removeLogo}
        onUpdate={(idx, patch) =>
          setLogos((prev) =>
            prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
          )
        }
        uploading={uploading}
      />
      <TokensSection tokens={tokens} setTokens={setTokens} />

      <div className="sticky bottom-4 flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/90 backdrop-blur p-4">
        <button
          onClick={save}
          disabled={isPending}
          className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {savedAt && (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">
            Saved.
          </span>
        )}
        <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-auto">
          {formatTimestamp(updatedAt)}
        </span>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">Error: {error}</p>
      )}
    </div>
  );
}

// ---------- Colors ----------------------------------------------------------

function ColorSection({
  colors,
  setColors,
}: {
  colors: DesignColor[];
  setColors: (next: DesignColor[]) => void;
}) {
  function update(idx: number, patch: Partial<DesignColor>) {
    setColors(colors.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function remove(idx: number) {
    setColors(colors.filter((_, i) => i !== idx));
  }
  function add() {
    setColors([...colors, { name: "", hex: "#000000" }]);
  }

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
      <header className="mb-4">
        <h2 className="font-semibold text-lg">Colors</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Hex values are passed verbatim to image-generation prompts.
        </p>
      </header>

      <div className="space-y-3">
        {colors.map((c, idx) => {
          const validHex = HEX_RE.test(c.hex);
          return (
            <div
              key={idx}
              className="grid grid-cols-[3rem_1fr_8rem_10rem_1fr_2.5rem] gap-3 items-center"
            >
              <div
                className="h-10 w-12 rounded-md border border-zinc-300 dark:border-zinc-700"
                style={{ background: validHex ? c.hex : "transparent" }}
                title={validHex ? c.hex : "invalid hex"}
              />
              <input
                type="text"
                value={c.name}
                onChange={(e) => update(idx, { name: e.target.value })}
                placeholder="Brand blue"
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-1.5 text-sm"
              />
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={validHex ? c.hex.slice(0, 7) : "#000000"}
                  onChange={(e) => update(idx, { hex: e.target.value })}
                  className="h-8 w-8 rounded border border-zinc-300 dark:border-zinc-700"
                />
                <input
                  type="text"
                  value={c.hex}
                  onChange={(e) => update(idx, { hex: e.target.value })}
                  placeholder="#0066ff"
                  className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-mono ${
                    validHex
                      ? "border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900"
                      : "border-red-400 bg-red-50 dark:bg-red-950/40"
                  }`}
                />
              </div>
              <select
                value={c.role ?? ""}
                onChange={(e) =>
                  update(idx, {
                    role: (e.target.value || undefined) as DesignColorRole | undefined,
                  })
                }
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-1.5 text-sm"
              >
                <option value="">— role —</option>
                {DESIGN_COLOR_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={c.usage ?? ""}
                onChange={(e) => update(idx, { usage: e.target.value || undefined })}
                placeholder="usage (optional)"
                className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-1.5 text-sm"
              />
              <button
                onClick={() => remove(idx)}
                aria-label="remove color"
                className="text-zinc-500 hover:text-red-600"
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          onClick={add}
          className="text-sm text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white"
        >
          + Add color
        </button>
      </div>
    </section>
  );
}

// ---------- Typography ------------------------------------------------------

function TypographySection({
  typography,
  setTypography,
}: {
  typography: DesignTypography;
  setTypography: (next: DesignTypography) => void;
}) {
  function update(patch: Partial<DesignTypography>) {
    setTypography({ ...typography, ...patch });
  }
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
      <header className="mb-4">
        <h2 className="font-semibold text-lg">Typography</h2>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field
          label="Heading family"
          value={typography.headingFamily ?? ""}
          onChange={(v) => update({ headingFamily: v || undefined })}
          placeholder="Inter, sans-serif"
        />
        <Field
          label="Body family"
          value={typography.bodyFamily ?? ""}
          onChange={(v) => update({ bodyFamily: v || undefined })}
          placeholder="Inter, sans-serif"
        />
        <Field
          label="Mono family"
          value={typography.monoFamily ?? ""}
          onChange={(v) => update({ monoFamily: v || undefined })}
          placeholder="JetBrains Mono"
        />
        <Field
          label="Weights (comma-separated)"
          value={(typography.weights ?? []).join(", ")}
          onChange={(v) => {
            const weights = v
              .split(/[,\s]+/)
              .map((s) => parseInt(s, 10))
              .filter((n) => Number.isFinite(n) && n >= 100 && n <= 900);
            update({ weights: weights.length ? weights : undefined });
          }}
          placeholder="400, 600, 700"
        />
      </div>
      <div className="mt-4">
        <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">
          Notes
        </label>
        <textarea
          value={typography.notes ?? ""}
          onChange={(e) => update({ notes: e.target.value || undefined })}
          rows={3}
          placeholder="Pairing rules, casing, line-height conventions…"
          className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm"
        />
      </div>
    </section>
  );
}

// ---------- Logos -----------------------------------------------------------

function LogoSection({
  logos,
  onUpload,
  onRemove,
  onUpdate,
  uploading,
}: {
  logos: LogoWithSignedUrl[];
  onUpload: (file: File, variant: DesignLogoVariant) => void;
  onRemove: (idx: number) => void;
  onUpdate: (idx: number, patch: Partial<DesignLogo>) => void;
  uploading: boolean;
}) {
  const [variant, setVariant] = useState<DesignLogoVariant>("primary");

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onUpload(file, variant);
    e.target.value = "";
  }

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
      <header className="mb-4">
        <h2 className="font-semibold text-lg">Logos</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          PNG, JPEG, SVG, WebP, or GIF, up to 5 MB. Signed URLs expire in one
          hour — re-open this page to refresh.
        </p>
      </header>

      <div className="flex items-center gap-3 mb-4">
        <select
          value={variant}
          onChange={(e) => setVariant(e.target.value as DesignLogoVariant)}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-1.5 text-sm"
        >
          {DESIGN_LOGO_VARIANTS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <label className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1.5 text-sm font-medium cursor-pointer disabled:opacity-50">
          {uploading ? "Uploading…" : "Upload logo"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
            onChange={onFile}
            disabled={uploading}
            className="hidden"
          />
        </label>
      </div>

      {logos.length === 0 && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No logos uploaded yet.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {logos.map((logo, idx) => (
          <div
            key={`${logo.storagePath}-${idx}`}
            className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-2"
          >
            <div className="aspect-video rounded bg-[conic-gradient(at_50%_50%,#e5e7eb_25%,transparent_0_50%,#e5e7eb_0_75%,transparent_0)] dark:bg-[conic-gradient(at_50%_50%,#27272a_25%,transparent_0_50%,#27272a_0_75%,transparent_0)] bg-[length:16px_16px] flex items-center justify-center overflow-hidden">
              {logo.signedUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logo.signedUrl}
                  alt={`${logo.variant} logo`}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="text-xs text-zinc-500">preview unavailable</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <select
                value={logo.variant}
                onChange={(e) =>
                  onUpdate(idx, { variant: e.target.value as DesignLogoVariant })
                }
                className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-1 text-xs"
              >
                {DESIGN_LOGO_VARIANTS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <button
                onClick={() => onRemove(idx)}
                className="text-xs text-red-600 hover:underline"
              >
                Remove
              </button>
            </div>
            <input
              type="text"
              value={logo.notes ?? ""}
              onChange={(e) => onUpdate(idx, { notes: e.target.value || undefined })}
              placeholder="notes (optional)"
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-1 text-xs"
            />
            <p className="text-[10px] font-mono text-zinc-400 truncate" title={logo.storagePath}>
              {logo.storagePath}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- Tokens ----------------------------------------------------------

function TokensSection({
  tokens,
  setTokens,
}: {
  tokens: DesignTokens;
  setTokens: (next: DesignTokens) => void;
}) {
  function update(patch: Partial<DesignTokens>) {
    setTokens({ ...tokens, ...patch });
  }
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
      <header className="mb-4">
        <h2 className="font-semibold text-lg">Other tokens</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Free-text descriptions of spacing, radii, shadows, and iconography.
        </p>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TokenField
          label="Spacing"
          value={tokens.spacing}
          onChange={(v) => update({ spacing: v })}
          placeholder="4 / 8 / 16 / 24 / 32 px scale"
        />
        <TokenField
          label="Radius"
          value={tokens.radii}
          onChange={(v) => update({ radii: v })}
          placeholder="6 px small, 12 px card, 9999 px pill"
        />
        <TokenField
          label="Shadows"
          value={tokens.shadows}
          onChange={(v) => update({ shadows: v })}
          placeholder="card: 0 1 2 rgba(0,0,0,.06), 0 1 3 rgba(0,0,0,.10)"
        />
        <TokenField
          label="Iconography"
          value={tokens.iconography}
          onChange={(v) => update({ iconography: v })}
          placeholder="Lucide line icons, 1.5 stroke"
        />
      </div>
      <div className="mt-4">
        <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">
          Notes
        </label>
        <textarea
          value={tokens.notes ?? ""}
          onChange={(e) => update({ notes: e.target.value || undefined })}
          rows={3}
          className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm"
        />
      </div>
    </section>
  );
}

// ---------- shared field helpers --------------------------------------------

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-1.5 text-sm"
      />
    </div>
  );
}

function TokenField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">
        {label}
      </label>
      <textarea
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        rows={2}
        placeholder={placeholder}
        className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm"
      />
    </div>
  );
}
