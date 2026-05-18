"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "../../ui";

export type PartnerLogoView = {
  id: string;
  label: string;
  storagePath: string;
  signedUrl: string | null;
  addedAt: string;
};

type Status =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "error"; message: string };

export function PartnerLogosPanel({
  campaignId,
  initial,
  maxLogos,
}: {
  campaignId: string;
  initial: PartnerLogoView[];
  maxLogos: number;
}) {
  const [logos, setLogos] = useState<PartnerLogoView[]>(initial);
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const atCap = logos.length >= maxLogos;
  const canSubmit =
    !pending &&
    !atCap &&
    status.kind !== "uploading" &&
    label.trim().length > 0 &&
    file !== null;

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !label.trim()) return;
    setStatus({ kind: "uploading" });
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("label", label.trim());
      const res = await fetch(
        `/api/campaigns/${campaignId}/partner-logos`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `upload failed (${res.status})`);
      }
      const data = (await res.json()) as { logo: PartnerLogoView };
      startTransition(() => {
        setLogos((prev) => [...prev, data.logo]);
        setLabel("");
        setFile(null);
        setStatus({ kind: "idle" });
        const input = document.getElementById(
          "partner-logo-file",
        ) as HTMLInputElement | null;
        if (input) input.value = "";
      });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function handleDelete(logoId: string) {
    const prev = logos;
    setLogos(prev.filter((l) => l.id !== logoId));
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/partner-logos/${logoId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `delete failed (${res.status})`);
      }
    } catch (err) {
      setLogos(prev);
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  return (
    <Card padded={false}>
      <div className="px-5 pt-4 pb-2">
        <CardHeader
          title="Partner logos"
          description={
            <>
              Third-party brand marks promoted by this campaign (e.g. a
              partner university, sponsor, co-branded program). Each uploaded
              logo is attached as a reference image when generating posts so
              the model places the real mark instead of fabricating one from
              the partner&rsquo;s name. Up to {maxLogos}.
            </>
          }
        />
      </div>

      <div className="border-t border-[var(--border)] px-5 py-4 bg-[var(--surface-2)]">
        {logos.length === 0 ? (
          <div className="text-xs text-mid mb-4">
            No partner logos yet. Without one, the image model may invent a
            plausible-looking crest for any institution named in the copy.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-4">
            {logos.map((logo) => (
              <div
                key={logo.id}
                className="surface p-3 flex flex-col items-center gap-2"
              >
                <div className="w-full aspect-square bg-white rounded-md flex items-center justify-center overflow-hidden">
                  {logo.signedUrl ? (
                    <img
                      src={logo.signedUrl}
                      alt={logo.label}
                      className="max-w-full max-h-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-mid">unavailable</span>
                  )}
                </div>
                <div className="w-full text-xs text-ink font-medium text-center truncate">
                  {logo.label}
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(logo.id)}
                  className="text-xs text-[var(--danger)] hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {atCap ? (
          <div className="text-xs text-mid">
            Maximum of {maxLogos} partner logos reached. Remove one to add
            another.
          </div>
        ) : (
          <form
            onSubmit={handleUpload}
            className="flex flex-col sm:flex-row gap-2 items-start sm:items-end"
          >
            <div className="flex-1 w-full">
              <label className="block text-xs text-mid mb-1" htmlFor="partner-logo-label">
                Partner name
              </label>
              <input
                id="partner-logo-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
                placeholder="Arden University"
                className="w-full px-3 py-2 rounded-md bg-[var(--surface)] border border-[var(--border)] text-sm text-ink placeholder:text-faint"
              />
            </div>
            <div className="flex-1 w-full">
              <label className="block text-xs text-mid mb-1" htmlFor="partner-logo-file">
                Logo file (PNG / JPG / WebP / SVG, ≤5 MB)
              </label>
              <input
                id="partner-logo-file"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm text-mid file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[var(--surface)] file:text-ink file:cursor-pointer"
              />
            </div>
            <button
              type="submit"
              disabled={!canSubmit}
              className="btn btn-primary btn-sm shrink-0"
            >
              {status.kind === "uploading" ? "Uploading…" : "Add logo"}
            </button>
          </form>
        )}

        {status.kind === "error" && (
          <div className="mt-3 text-xs text-[var(--danger)]">
            {status.message}
          </div>
        )}
      </div>
    </Card>
  );
}
