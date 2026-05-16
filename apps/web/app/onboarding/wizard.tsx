"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BRAND_MEMORY_SLUGS,
  BRAND_MEMORY_TITLES,
  type BrandDocStatus,
  type BrandMemorySlug,
  type DesignColor,
  type DesignTokens,
  type DesignTypography,
} from "@marketing/shared-types";

export type ExistingBrandDoc = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: BrandDocStatus;
  pageCount: number | null;
  uploadedAt: string;
};

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

type Step = "welcome" | "upload" | "generate" | "review";

type Props = {
  workspaceId: string;
  userEmail: string | null;
  initialDocs: ExistingBrandDoc[];
};

const ACCEPT =
  ".pdf,.docx,.md,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain";

export function OnboardingWizard({ workspaceId: _workspaceId, userEmail, initialDocs }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [brandName, setBrandName] = useState("");
  const [pitch, setPitch] = useState("");
  const [docs, setDocs] = useState<ExistingBrandDoc[]>(initialDocs);
  const [drafts, setDrafts] = useState<ExtractDrafts | null>(null);
  const [model, setModel] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <Header step={step} userEmail={userEmail} />
      {step === "welcome" && (
        <WelcomeStep
          brandName={brandName}
          pitch={pitch}
          setBrandName={setBrandName}
          setPitch={setPitch}
          onNext={() => setStep("upload")}
          onSkip={async () => {
            await seedFromAnswersAndExit(router, brandName, pitch);
          }}
        />
      )}
      {step === "upload" && (
        <UploadStep
          docs={docs}
          setDocs={setDocs}
          onBack={() => setStep("welcome")}
          onNext={() => setStep("generate")}
          onSkip={async () => {
            await seedFromAnswersAndExit(router, brandName, pitch);
          }}
        />
      )}
      {step === "generate" && (
        <GenerateStep
          brandName={brandName}
          pitch={pitch}
          hasDocs={docs.length > 0}
          onBack={() => setStep("upload")}
          onDrafts={(d, m) => {
            setDrafts(d);
            setModel(m);
            setStep("review");
          }}
          onSkip={async () => {
            await seedFromAnswersAndExit(router, brandName, pitch);
          }}
        />
      )}
      {step === "review" && drafts && (
        <ReviewStep
          drafts={drafts}
          model={model}
          onBack={() => setStep("generate")}
          onSaved={() => {
            router.replace("/campaigns");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function Header({ step, userEmail }: { step: Step; userEmail: string | null }) {
  const steps: Step[] = ["welcome", "upload", "generate", "review"];
  const labels: Record<Step, string> = {
    welcome: "About you",
    upload: "Source docs",
    generate: "Generate",
    review: "Review & save",
  };
  const currentIdx = steps.indexOf(step);

  return (
    <header className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-faint">
        <span className="mono uppercase tracking-wider">Setup</span>
        {userEmail && <span className="mono truncate max-w-[260px]">{userEmail}</span>}
      </div>
      <h1 className="text-xl font-semibold text-ink">
        Let&apos;s teach the agent your brand
      </h1>
      <ol className="flex items-center gap-1.5 text-[11px]">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            <span
              className={[
                "h-1.5 w-6 rounded-full transition-colors",
                i <= currentIdx
                  ? "bg-[var(--accent)]"
                  : "bg-[var(--surface-2)]",
              ].join(" ")}
            />
            <span
              className={i === currentIdx ? "text-ink" : "text-faint"}
            >
              {labels[s]}
            </span>
          </li>
        ))}
      </ol>
    </header>
  );
}

function WelcomeStep({
  brandName,
  pitch,
  setBrandName,
  setPitch,
  onNext,
  onSkip,
}: {
  brandName: string;
  pitch: string;
  setBrandName: (v: string) => void;
  setPitch: (v: string) => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const ready = brandName.trim().length > 0 && pitch.trim().length > 0;
  return (
    <section className="surface p-6 space-y-5">
      <p className="text-sm text-mid">
        Two quick questions so the agent has a starting point. You can change
        anything later under Brand.
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-mid">Brand or company name</span>
        <input
          autoFocus
          value={brandName}
          onChange={(e) => setBrandName(e.target.value)}
          placeholder="e.g. Veru"
          className="field"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-mid">
          What do you sell, and who is it for?
        </span>
        <textarea
          value={pitch}
          onChange={(e) => setPitch(e.target.value)}
          placeholder="One or two sentences. Plain language."
          rows={3}
          className="field"
        />
      </label>
      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onSkip} className="btn btn-ghost btn-sm">
          Skip setup
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!ready}
          className="btn btn-primary btn-sm disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </section>
  );
}

function UploadStep({
  docs,
  setDocs,
  onBack,
  onNext,
  onSkip,
}: {
  docs: ExistingBrandDoc[];
  setDocs: (next: ExistingBrandDoc[]) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of arr) form.append("file", f);
      const res = await fetch("/api/brand-documents", { method: "POST", body: form });
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
      const created = (await res.json()) as ExistingBrandDoc[];
      setDocs([
        ...created.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) })),
        ...docs,
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/brand-documents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setDocs(docs.filter((d) => d.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="surface p-6 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-ink">Upload reference material</h2>
        <p className="mt-1 text-xs text-mid">
          Brand books, product overviews, decks, customer notes — anything that
          describes your business. PDF, MD, or TXT. The agent will distill these
          into a brand voice, ICP, and design system on the next step.
        </p>
      </div>

      <label
        htmlFor="onb-upload"
        className="surface block cursor-pointer p-6 text-center border-dashed"
        style={{ borderStyle: "dashed" }}
      >
        <input
          ref={fileRef}
          id="onb-upload"
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
        <div className="text-sm font-semibold text-ink">
          {uploading ? "Uploading…" : "Drop files here or click to upload"}
        </div>
        <div className="mt-1 text-xs text-mid">PDF · MD · TXT · up to 25 MB each</div>
      </label>

      {error && <p className="text-sm text-[var(--danger)]">Error: {error}</p>}

      {docs.length > 0 && (
        <ul className="surface-2 divide-y divide-[var(--border)] rounded-md">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm text-ink truncate">{d.filename}</div>
                <div className="text-[11px] text-mid mono">
                  {(d.sizeBytes / 1024).toFixed(1)} KB · {d.status}
                </div>
              </div>
              <button onClick={() => remove(d.id)} className="btn btn-ghost btn-xs">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onBack} className="btn btn-ghost btn-sm">
          ← Back
        </button>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onSkip} className="btn btn-ghost btn-sm">
            Skip
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={docs.length === 0}
            className="btn btn-primary btn-sm disabled:opacity-50"
            title={docs.length === 0 ? "Upload at least one document" : ""}
          >
            Continue
          </button>
        </div>
      </div>
    </section>
  );
}

function GenerateStep({
  brandName,
  pitch,
  hasDocs,
  onBack,
  onDrafts,
  onSkip,
}: {
  brandName: string;
  pitch: string;
  hasDocs: boolean;
  onBack: () => void;
  onDrafts: (d: ExtractDrafts, model: string | null) => void;
  onSkip: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (!hasDocs) {
      setError("Upload at least one source document first.");
      return;
    }
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/brand-extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandName, pitch }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(err.message ?? err.error ?? `Generation failed (${res.status})`);
      }
      const data = (await res.json()) as {
        drafts: ExtractDrafts;
        model: string;
      };
      onDrafts(data.drafts, data.model);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="surface p-6 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-ink">
          Generate brand memory + design system
        </h2>
        <p className="mt-1 text-xs text-mid">
          We&apos;ll read every document you uploaded and draft five brand-memory
          documents plus a structured palette and typography. You&apos;ll review
          and edit everything before it&apos;s saved.
        </p>
      </div>

      <div className="surface-2 p-4 rounded-md text-xs text-mid space-y-1">
        <div>
          <span className="text-faint">Brand:</span>{" "}
          <span className="text-ink">{brandName || "—"}</span>
        </div>
        <div>
          <span className="text-faint">Pitch:</span>{" "}
          <span className="text-ink">{pitch || "—"}</span>
        </div>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">Error: {error}</p>}

      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onBack} className="btn btn-ghost btn-sm">
          ← Back
        </button>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onSkip} className="btn btn-ghost btn-sm">
            Skip
          </button>
          <button
            type="button"
            onClick={generate}
            disabled={!hasDocs || generating}
            className="btn btn-primary btn-sm disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate drafts"}
          </button>
        </div>
      </div>
    </section>
  );
}

function ReviewStep({
  drafts,
  model,
  onBack,
  onSaved,
}: {
  drafts: ExtractDrafts;
  model: string | null;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [bodies, setBodies] = useState<Record<BrandMemorySlug, string>>({
    "brand.voice": drafts.voice,
    "brand.icp": drafts.icp,
    "brand.visual": drafts.visual,
    "product.state": drafts.productState,
    "product.positioning": drafts.productPositioning,
    // Market context is human-authored on the Brand page after onboarding;
    // extraction doesn't draft it. Filtered out of the save + render below.
    "market.context": "",
  });
  const [colors, setColors] = useState<DesignColor[]>(drafts.design.colors);
  const [typography] = useState<DesignTypography>(drafts.design.typography);
  const [tokens] = useState<DesignTokens>(drafts.design.tokens);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save() {
    setSaveError(null);
    setSaving(true);
    try {
      const extractedSlugs = BRAND_MEMORY_SLUGS.filter((s) => s !== "market.context");
      await Promise.all(
        extractedSlugs.map(async (slug) => {
          const res = await fetch(`/api/brand-memory/${encodeURIComponent(slug)}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: BRAND_MEMORY_TITLES[slug],
              body: bodies[slug],
            }),
          });
          if (!res.ok) throw new Error(`Save failed for ${slug} (${res.status})`);
        }),
      );

      const dsRes = await fetch("/api/brand-design-system");
      const current = dsRes.ok
        ? ((await dsRes.json()) as {
            logos: Array<{
              variant: string;
              storagePath: string;
              contentType?: string;
              notes?: string;
            }>;
          })
        : { logos: [] };

      const dsPut = await fetch("/api/brand-design-system", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          colors,
          typography,
          logos: current.logos.map((l) => ({
            variant: l.variant,
            storagePath: l.storagePath,
            contentType: l.contentType,
            notes: l.notes,
          })),
          tokens,
        }),
      });
      if (!dsPut.ok) throw new Error(`Design system save failed (${dsPut.status})`);
      onSaved();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="surface p-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Review drafts</h2>
          <p className="mt-1 text-xs text-mid">
            Edit anything you want. Saving writes everything to brand memory
            and the design system in one go.
          </p>
        </div>
        {model && <span className="text-[11px] text-faint mono">model: {model}</span>}
      </div>

      <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
        {BRAND_MEMORY_SLUGS.filter((s) => s !== "market.context").map((slug) => (
          <div key={slug} className="surface-2 p-3 rounded-md">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-xs font-semibold text-ink">
                {BRAND_MEMORY_TITLES[slug]}
              </h3>
              <span className="text-[11px] text-faint mono">{slug}</span>
            </div>
            <textarea
              value={bodies[slug]}
              onChange={(e) =>
                setBodies((prev) => ({ ...prev, [slug]: e.target.value }))
              }
              rows={6}
              className="field w-full font-mono text-[12px]"
            />
          </div>
        ))}

        <div className="surface-2 p-3 rounded-md">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="text-xs font-semibold text-ink">Palette</h3>
            <span className="text-[11px] text-faint mono">design.colors</span>
          </div>
          {colors.length === 0 ? (
            <p className="text-xs text-mid">
              No colors extracted from the source docs.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {colors.map((c, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 surface px-2 py-1 rounded"
                >
                  <span
                    className="h-5 w-5 rounded border border-[var(--border)]"
                    style={{ background: c.hex }}
                  />
                  <span className="text-xs text-ink">{c.name || "—"}</span>
                  <span className="text-[11px] text-faint mono">{c.hex}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setColors(colors.filter((_, idx) => idx !== i))
                    }
                    className="text-faint hover:text-ink text-xs ml-1"
                    aria-label="Remove color"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {saveError && (
        <p className="text-sm text-[var(--danger)]">Error: {saveError}</p>
      )}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="btn btn-ghost btn-sm"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="btn btn-primary btn-sm"
        >
          {saving ? "Saving…" : "Save & finish"}
        </button>
      </div>
    </section>
  );
}

async function seedFromAnswersAndExit(
  router: ReturnType<typeof useRouter>,
  brandName: string,
  pitch: string,
) {
  // Write a single brand.voice seed so the gate in (admin) layout treats the
  // workspace as onboarded. Empty answers still get a placeholder body so the
  // user isn't trapped in this wizard on every login.
  const body =
    brandName.trim() || pitch.trim()
      ? [
          brandName.trim() ? `# ${brandName.trim()}` : "",
          pitch.trim(),
          "",
          "_Initial seed from onboarding. Edit under Brand to fill in the rest._",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "_Onboarding skipped — fill in under Brand._";

  await fetch(`/api/brand-memory/${encodeURIComponent("brand.voice")}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: BRAND_MEMORY_TITLES["brand.voice"],
      body,
    }),
  });
  router.replace("/campaigns");
  router.refresh();
}
