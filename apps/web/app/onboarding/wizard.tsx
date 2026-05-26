"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BRAND_MEMORY_SLUGS,
  BRAND_MEMORY_TITLES,
  type BrandDocStatus,
  type BrandMemorySlug,
  type DesignColor,
  type DesignTokens,
  type DesignTypography,
  type SocialProvider,
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

export type ConnectionSummary = {
  provider: SocialProvider;
  accountLabel: string;
  /** True for `meta` connections whose Page has a linked IG Business account. */
  hasInstagram: boolean;
};

type Props = {
  workspaceId: string;
  workspaceName: string;
  userEmail: string | null;
  initialDocs: ExistingBrandDoc[];
  initialConnections: ConnectionSummary[];
};

const ACCEPT =
  ".pdf,.docx,.md,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain";

export function OnboardingWizard({
  workspaceId: _workspaceId,
  workspaceName,
  userEmail,
  initialDocs,
  initialConnections,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [website, setWebsite] = useState("");
  const [docs, setDocs] = useState<ExistingBrandDoc[]>(initialDocs);
  const [drafts, setDrafts] = useState<ExtractDrafts | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>(initialConnections);

  // The Sources step no longer asks for a brand name; we seed from the
  // workspace name so the skip path still has something to write.
  const brandName = workspaceName;

  return (
    <div className="space-y-6">
      <Header step={step} userEmail={userEmail} workspaceName={workspaceName} />
      {step === "welcome" && (
        <SourcesStep
          website={website}
          setWebsite={setWebsite}
          docs={docs}
          setDocs={setDocs}
          connections={connections}
          setConnections={setConnections}
          onScraped={() => setStep("generate")}
          onNoUrl={() => setStep("upload")}
          onSkip={async () => {
            await seedFromAnswersAndExit(router, brandName, "");
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
            await seedFromAnswersAndExit(router, brandName, "");
          }}
        />
      )}
      {step === "generate" && (
        <GenerateStep
          brandName={brandName}
          pitch=""
          hasDocs={docs.length > 0}
          onBack={() => setStep("upload")}
          onDrafts={(d, m) => {
            setDrafts(d);
            setModel(m);
            setStep("review");
          }}
          onSkip={async () => {
            await seedFromAnswersAndExit(router, brandName, "");
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

type TabKey = "sources" | "brand-dna" | "ideas" | "drafts";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  {
    key: "sources",
    label: "Sources",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
      </svg>
    ),
  },
  {
    key: "brand-dna",
    label: "Brand DNA",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
    ),
  },
  {
    key: "ideas",
    label: "Ideas",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 3l1.5 3L9.5 7.5 6.5 9 5 12l-1.5-3L0.5 7.5 3.5 6z" transform="translate(7 4)" />
        <path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
      </svg>
    ),
  },
  {
    key: "drafts",
    label: "Drafts",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l2.4 5.6L20 9l-4.2 3.8L17 19l-5-2.8L7 19l1.2-6.2L4 9l5.6-1.4z" />
      </svg>
    ),
  },
];

const STEP_TO_TAB: Record<Step, TabKey> = {
  welcome: "sources",
  upload: "brand-dna",
  generate: "ideas",
  review: "drafts",
};

function Header({
  step,
  userEmail,
  workspaceName,
}: {
  step: Step;
  userEmail: string | null;
  workspaceName: string;
}) {
  const steps: Step[] = ["welcome", "upload", "generate", "review"];
  const currentIdx = steps.indexOf(step);
  const activeTab = STEP_TO_TAB[step];

  return (
    <header className="space-y-3">
      {userEmail && (
        <div className="flex justify-end text-[11px] text-faint">
          <span className="mono truncate max-w-[260px]">{userEmail}</span>
        </div>
      )}
      <nav className="flex justify-center">
        <ul className="inline-flex items-center gap-1 surface-2 rounded-full p-1">
          {TABS.map((t) => {
            const isActive = t.key === activeTab;
            return (
              <li key={t.key}>
                <span
                  className={[
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
                    isActive
                      ? "bg-[var(--surface-3)] text-ink"
                      : "text-faint",
                  ].join(" ")}
                >
                  <span aria-hidden="true">{t.icon}</span>
                  {t.label}
                </span>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="text-center space-y-2">
        <p className="text-[12px] text-mid">
          Step {currentIdx + 1} of {steps.length}
        </p>
        <h1 className="text-2xl font-semibold text-ink tracking-tight">
          Let&apos;s set up {workspaceName}&apos;s Team
        </h1>
      </div>
    </header>
  );
}

type SocialChannelId = "instagram" | "tiktok" | "facebook" | "linkedin" | "x";

type SocialChannel = {
  id: SocialChannelId;
  name: string;
  /**
   * The SocialProvider this channel maps to in the OAuth backend. Multiple
   * channels can share a provider (instagram + facebook both use "meta").
   * Null means the channel has no working OAuth integration yet (tiktok).
   */
  provider: SocialProvider | null;
  comingSoon?: boolean;
  icon: React.ReactNode;
};

const SOCIAL_CHANNELS: SocialChannel[] = [
  {
    id: "instagram",
    name: "Instagram",
    provider: "meta",
    icon: (
      <span
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white"
        style={{
          background:
            "linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)",
        }}
        aria-hidden="true"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.5" cy="6.5" r="0.5" fill="currentColor" />
        </svg>
      </span>
    ),
  },
  {
    id: "tiktok",
    name: "TikTok",
    provider: null,
    comingSoon: true,
    icon: (
      <span
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-black text-white"
        aria-hidden="true"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.6 6.7c-1.4-.1-2.7-.9-3.4-2.1-.4-.6-.6-1.4-.6-2.1h-3v13.4c0 1.5-1.2 2.7-2.7 2.7s-2.7-1.2-2.7-2.7 1.2-2.7 2.7-2.7c.3 0 .6.1.9.2v-3c-.3 0-.6-.1-.9-.1-3.2 0-5.7 2.6-5.7 5.7s2.6 5.7 5.7 5.7 5.7-2.6 5.7-5.7V9.4c1.2.8 2.7 1.3 4.2 1.3v-3c-.1 0-.2 0-.2-.1z" />
        </svg>
      </span>
    ),
  },
  {
    id: "facebook",
    name: "Facebook",
    provider: "meta",
    icon: (
      <span
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white"
        style={{ background: "#1877F2" }}
        aria-hidden="true"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M22 12c0-5.5-4.5-10-10-10S2 6.5 2 12c0 5 3.7 9.1 8.4 9.9V15h-2.5v-3h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.3 0-1.7.8-1.7 1.6V12h2.8l-.4 3h-2.4v6.9C18.3 21.1 22 17 22 12z" />
        </svg>
      </span>
    ),
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    provider: "linkedin",
    icon: (
      <span
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white"
        style={{ background: "#0A66C2" }}
        aria-hidden="true"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.5 2h-17A1.5 1.5 0 002 3.5v17A1.5 1.5 0 003.5 22h17a1.5 1.5 0 001.5-1.5v-17A1.5 1.5 0 0020.5 2zM8 19H5V8h3v11zM6.5 6.7a1.7 1.7 0 110-3.4 1.7 1.7 0 010 3.4zM19 19h-3v-5.4c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9V19h-3V8h2.9v1.5h.1c.4-.8 1.4-1.7 2.9-1.7 3.1 0 3.7 2 3.7 4.7V19z" />
        </svg>
      </span>
    ),
  },
  {
    id: "x",
    name: "X",
    provider: "x",
    icon: (
      <span
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-black text-white opacity-60"
        aria-hidden="true"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </span>
    ),
  },
];

function isChannelConnected(
  c: SocialChannel,
  connections: ConnectionSummary[],
): ConnectionSummary | null {
  if (!c.provider) return null;
  const match = connections.find((conn) => conn.provider === c.provider);
  if (!match) return null;
  // Instagram is "connected" only when the Meta connection has an IG Business
  // account linked. Without it, IG publishing won't work.
  if (c.id === "instagram" && !match.hasInstagram) return null;
  return match;
}

function SourcesStep({
  website,
  setWebsite,
  docs,
  setDocs,
  connections,
  setConnections,
  onScraped,
  onNoUrl,
  onSkip,
}: {
  website: string;
  setWebsite: (v: string) => void;
  docs: ExistingBrandDoc[];
  setDocs: (next: ExistingBrandDoc[]) => void;
  connections: ConnectionSummary[];
  setConnections: (next: ConnectionSummary[]) => void;
  onScraped: () => void;
  onNoUrl: () => void;
  onSkip: () => void;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [scraping, setScraping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthBanner, setOAuthBanner] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);
  const hasUrl = website.trim().length > 0;
  const connectableCount = SOCIAL_CHANNELS.filter((c) => !c.comingSoon).length;
  const connectedCount = SOCIAL_CHANNELS.reduce(
    (n, c) => n + (isChannelConnected(c, connections) ? 1 : 0),
    0,
  );

  // Pick up the ?oauth=...&status=... that the callback redirect appends.
  useEffect(() => {
    const oauth = search.get("oauth");
    const status = search.get("status");
    if (!oauth || !status) return;
    if (status === "connected") {
      setOAuthBanner({ kind: "success", text: `${oauth} connected.` });
    } else {
      setOAuthBanner({
        kind: "error",
        text: `${oauth}: ${search.get("message") ?? "connection failed"}`,
      });
    }
    // Strip the params and re-fetch the server-side state.
    router.replace("/onboarding");
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function disconnect(provider: SocialProvider) {
    setOAuthBanner(null);
    try {
      const res = await fetch(`/api/oauth/${provider}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Disconnect failed (${res.status})`);
      setConnections(connections.filter((c) => c.provider !== provider));
    } catch (e) {
      setOAuthBanner({ kind: "error", text: (e as Error).message });
    }
  }

  async function handleContinue() {
    if (!hasUrl) {
      onNoUrl();
      return;
    }
    setError(null);
    setScraping(true);
    try {
      const res = await fetch("/api/brand-scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: website.trim() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (err.error === "empty" || err.error === "non_html" || err.error === "fetch_failed") {
          setError(
            `${err.message ?? "Couldn't read the site."} You can upload documents instead.`,
          );
          return;
        }
        throw new Error(err.message ?? err.error ?? `Scrape failed (${res.status})`);
      }
      const data = (await res.json()) as {
        document: ExistingBrandDoc & { sizeBytes: number | string };
      };
      const doc: ExistingBrandDoc = {
        ...data.document,
        sizeBytes: Number(data.document.sizeBytes),
      };
      setDocs([doc, ...docs]);
      onScraped();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScraping(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-center text-sm text-mid">
        Start with the basics. Add your website and any socials you want the
        agent to learn from.
      </p>

      <section className="surface p-5 space-y-2">
        <label htmlFor="onb-website" className="text-xs text-mid">
          Website URL
        </label>
        <div className="relative">
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            aria-hidden="true"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
            </svg>
          </span>
          <input
            id="onb-website"
            autoFocus
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://yourcompany.com"
            className="field w-full pl-9"
            inputMode="url"
            autoComplete="url"
          />
        </div>
        <p className="text-[11px] text-faint">
          Add your website to let AI pull product, tone, and audience cues
          automatically.
        </p>
      </section>

      <section className="surface p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Social accounts</h2>
          <span className="text-[11px] text-faint">
            {connectedCount}/{connectableCount} connected
          </span>
        </div>
        {oauthBanner && (
          <div
            className={[
              "text-xs rounded-md px-3 py-2",
              oauthBanner.kind === "success"
                ? "bg-[var(--success-bg,#102f1d)] text-[var(--success,#5ee29a)]"
                : "bg-[var(--danger-bg,#2f1010)] text-[var(--danger)]",
            ].join(" ")}
          >
            {oauthBanner.text}
          </div>
        )}
        <ul className="divide-y divide-[var(--border)]">
          {SOCIAL_CHANNELS.map((c) => {
            const connected = isChannelConnected(c, connections);
            return (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {c.icon}
                  <div className="min-w-0">
                    <div
                      className={[
                        "text-sm font-medium truncate",
                        c.comingSoon ? "text-faint" : "text-ink",
                      ].join(" ")}
                    >
                      {c.name}
                      {c.comingSoon && (
                        <span className="text-faint font-normal">
                          {" "}
                          (coming soon)
                        </span>
                      )}
                    </div>
                    {connected && (
                      <div className="text-[11px] text-faint truncate">
                        {connected.accountLabel}
                      </div>
                    )}
                  </div>
                </div>
                {c.comingSoon ? (
                  <button
                    type="button"
                    disabled
                    className="btn btn-secondary btn-sm opacity-60 cursor-not-allowed"
                    title="Coming soon"
                  >
                    Coming soon
                  </button>
                ) : connected ? (
                  <button
                    type="button"
                    onClick={() => disconnect(connected.provider)}
                    className="btn btn-secondary btn-sm"
                  >
                    Disconnect
                  </button>
                ) : (
                  <a
                    href={`/api/oauth/${c.provider}/start?return_to=/onboarding`}
                    className="btn btn-secondary btn-sm"
                  >
                    Connect
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-[11px] text-faint">
          Connecting opens the provider&apos;s sign-in page. Tokens are stored
          encrypted and scoped to this workspace.
        </p>
      </section>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onSkip}
          disabled={scraping}
          className="btn btn-ghost btn-sm"
        >
          Skip setup
        </button>
        <button
          type="button"
          onClick={handleContinue}
          disabled={scraping}
          className="btn btn-primary btn-sm disabled:opacity-50"
        >
          {scraping
            ? "Reading site…"
            : hasUrl
              ? "Read site & continue →"
              : "Continue →"}
        </button>
      </div>
    </div>
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
        <h2 className="text-sm font-semibold text-ink">
          {docs.length > 0 ? "Sources" : "Upload reference material"}
        </h2>
        <p className="mt-1 text-xs text-mid">
          {docs.length > 0
            ? "These are the sources we'll distill into a brand voice, ICP, and design system on the next step. Add more if you have brand books, product decks, or customer notes — or continue with what's here."
            : "Brand books, product overviews, decks, customer notes — anything that describes your business. PDF, MD, or TXT. The agent will distill these into a brand voice, ICP, and design system on the next step."}
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
      const seed: Record<string, string> = {};
      if (brandName.trim()) seed.brandName = brandName.trim();
      if (pitch.trim()) seed.pitch = pitch.trim();
      const res = await fetch("/api/brand-extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(seed),
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
