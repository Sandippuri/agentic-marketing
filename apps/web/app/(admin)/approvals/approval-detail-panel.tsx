"use client";

import { Fragment, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  useDecideApproval,
  useGenerateAssets,
  useSelectAsset,
} from "@/lib/query/use-approvals";
import { parseRationale } from "@marketing/shared-types";
import { isVideoAsset } from "@/lib/asset-media";
import type { PendingApproval } from "./approval-row";

const MARKER_RE = /\[IMAGE(?:\s*\d+)?:[^\]]+\]/gi;

type BodySegment =
  | { kind: "text"; value: string }
  | { kind: "image"; index: number; description: string };

function splitBody(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  let lastIdx = 0;
  let imageIdx = 0;
  for (const match of body.matchAll(MARKER_RE)) {
    const start = match.index ?? 0;
    if (start > lastIdx) {
      out.push({ kind: "text", value: body.slice(lastIdx, start) });
    }
    const desc = match[0]
      .replace(/^\[IMAGE(?:\s*\d+)?:\s*/i, "")
      .replace(/\]$/, "")
      .trim();
    out.push({ kind: "image", index: imageIdx++, description: desc });
    lastIdx = start + match[0].length;
  }
  if (lastIdx < body.length) {
    out.push({ kind: "text", value: body.slice(lastIdx) });
  }
  return out;
}

export function ApprovalDetailPanel({
  approval,
  onClose,
}: {
  approval: PendingApproval | null;
  onClose: () => void;
}) {
  // Esc closes the panel.
  useEffect(() => {
    if (!approval) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approval, onClose]);

  const isOpen = !!approval;

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px] transition-opacity duration-200 ${
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Approval details"
        className={`fixed top-0 right-0 z-50 h-screen w-full max-w-[680px] bg-[var(--surface)] border-l border-[var(--border)] shadow-2xl transition-transform duration-200 ease-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {approval && <DetailBody key={approval.id} approval={approval} onClose={onClose} />}
      </aside>
    </>
  );
}

function DetailBody({
  approval,
  onClose,
}: {
  approval: PendingApproval;
  onClose: () => void;
}) {
  const router = useRouter();
  const decide = useDecideApproval();
  const selectAsset = useSelectAsset();
  const generateAssets = useGenerateAssets();

  const [reason, setReason] = useState("");
  const [reasonMode, setReasonMode] = useState<
    "changes_requested" | "rejected" | null
  >(null);
  // Which slot the user is currently inspecting. Defaults to slot 0 (lead).
  const [activeSlot, setActiveSlot] = useState(0);
  // Preview index is per-slot — switching slots resets to the slot's first
  // renderable asset. Stored as a map so navigating between slots remembers
  // where the reviewer was within each.
  const [previewIdxBySlot, setPreviewIdxBySlot] = useState<
    Record<number, number>
  >({});

  // Group renderable assets by slot. Each slot is { slotIndex, assets[] }
  // where assets[] is the slot's variant strip (approved first, drafts
  // following). slotIndex order = display order (cover at 0, swipes after).
  const renderableAll = approval.assets.filter((a) => a.signedUrl);
  const slotsMap = new Map<number, typeof renderableAll>();
  for (const a of renderableAll) {
    const slot = a.sequenceOrder ?? 0;
    if (!slotsMap.has(slot)) slotsMap.set(slot, []);
    slotsMap.get(slot)!.push(a);
  }
  const slots = [...slotsMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slotIndex, assets]) => ({
      slotIndex,
      // Approved variant first so the carousel opens on the canonical pick.
      assets: [...assets].sort((a, b) =>
        a.status === "approved" ? -1 : b.status === "approved" ? 1 : 0,
      ),
    }));

  const safeActiveSlot =
    slots.length === 0
      ? 0
      : slots.find((s) => s.slotIndex === activeSlot)?.slotIndex ??
        slots[0]!.slotIndex;
  const activeSlotData =
    slots.find((s) => s.slotIndex === safeActiveSlot) ?? null;
  const renderable = activeSlotData?.assets ?? [];

  // Slot-0 approved is the canonical lead the post will publish with. Used
  // for the row thumbnail elsewhere — here we still expose committedId
  // scoped to the active slot so "selected" badges read correctly.
  const committedId =
    renderable.find((a) => a.status === "approved")?.id ?? renderable[0]?.id ?? null;

  const previewIdx = previewIdxBySlot[safeActiveSlot] ?? 0;
  const safePreviewIdx =
    renderable.length === 0 ? 0 : Math.min(previewIdx, renderable.length - 1);
  const previewAsset = renderable[safePreviewIdx] ?? null;
  const previewIsCommitted = previewAsset?.id === committedId;
  const isMultiSlot = slots.length > 1;

  // Body markers ([IMAGE 1: ...], [IMAGE 2: ...]) reference *images at
  // publish time* — one canonical (approved) asset per slot, ordered by
  // sequenceOrder. Independent of which slot the reviewer is previewing.
  const committedBySlot = slots
    .map((s) => s.assets.find((a) => a.status === "approved") ?? s.assets[0])
    .filter(Boolean);

  const { rationale, bodyCopy } = parseRationale(approval.bodyMd ?? "");
  const bodySegments = bodyCopy ? splitBody(bodyCopy) : [];
  const hasMarkers = bodySegments.some((s) => s.kind === "image");

  const isStale = approval.ageLabel?.includes("d");

  function decideWith(
    decision: "approved" | "changes_requested" | "rejected",
    r?: string,
  ) {
    decide.mutate(
      { approvalId: approval.id, decision, reason: r },
      {
        onSuccess: () => {
          onClose();
          router.refresh();
        },
      },
    );
  }

  function setPreviewIdxForActive(updater: (prev: number) => number) {
    setPreviewIdxBySlot((m) => ({
      ...m,
      [safeActiveSlot]: updater(m[safeActiveSlot] ?? 0),
    }));
  }
  function handlePrev() {
    if (renderable.length < 2) return;
    setPreviewIdxForActive((i) => (i - 1 + renderable.length) % renderable.length);
  }
  function handleNext() {
    if (renderable.length < 2) return;
    setPreviewIdxForActive((i) => (i + 1) % renderable.length);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 px-5 py-4 hairline-b">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-ink leading-snug">
            {approval.contentTitle}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="badge badge-neutral">{approval.contentType}</span>
            <span className="badge badge-info capitalize">{approval.contentStage}</span>
            <span
              className={`badge ${isStale ? "badge-warn" : "badge-neutral"}`}
              title={new Date(approval.requestedAt).toLocaleString()}
            >
              {approval.ageLabel ?? new Date(approval.requestedAt).toLocaleString()}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="btn btn-ghost btn-sm shrink-0"
          aria-label="Close details"
          title="Close (Esc)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* SLOT TABS — only when the post carries multiple images. Each tab
            owns its own variant carousel + regenerate button below. */}
        {approval.needsImages && isMultiSlot && (
          <section className="px-5 pt-4">
            <div className="flex items-center gap-1.5 flex-wrap">
              {slots.map((s) => {
                const slotHasApproved = s.assets.some(
                  (a) => a.status === "approved",
                );
                const isActive = s.slotIndex === safeActiveSlot;
                return (
                  <button
                    key={s.slotIndex}
                    type="button"
                    onClick={() => setActiveSlot(s.slotIndex)}
                    className={`text-xs px-2.5 py-1.5 rounded-md border transition-colors ${
                      isActive
                        ? "border-[var(--accent)] text-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]"
                        : "border-[var(--border)] text-mid hover:text-ink"
                    }`}
                  >
                    Image {s.slotIndex + 1}
                    {slotHasApproved && (
                      <span
                        className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: "var(--success)" }}
                        aria-label="Has approved asset"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* HERO IMAGE */}
        <section className="px-5 pt-5">
          {!approval.needsImages ? (
            <div className="aspect-[16/10] rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] grid place-items-center text-center text-faint">
              <div className="flex flex-col items-center gap-2">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3l18 18" />
                  <path d="M21 16V5a2 2 0 00-2-2H7" />
                  <path d="M3 7v12a2 2 0 002 2h12" />
                </svg>
                <span className="text-xs">Images disabled for this post</span>
              </div>
            </div>
          ) : renderable.length === 0 ? (
            <button
              type="button"
              onClick={() =>
                generateAssets.mutate(
                  // Scope the generation to the active slot when the post
                  // has multiple — otherwise an empty slot 2 triggers a
                  // full-post regen and rewrites slot 1's already-approved
                  // image. Bare call (no slotIndex) is the single-image path.
                  isMultiSlot
                    ? {
                        contentId: approval.contentId,
                        slotIndex: safeActiveSlot,
                      }
                    : { contentId: approval.contentId },
                  { onSuccess: () => router.refresh() },
                )
              }
              disabled={generateAssets.isPending}
              className="aspect-[16/10] w-full rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] grid place-items-center gap-2 text-center transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-3)] disabled:cursor-wait disabled:opacity-70"
            >
              {generateAssets.isPending ? (
                <>
                  <svg className="spin text-mid" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M21 12a9 9 0 11-6.219-8.56" />
                  </svg>
                  <span className="text-xs text-mid">
                    {isMultiSlot
                      ? `Generating image ${safeActiveSlot + 1}…`
                      : "Generating variants…"}
                  </span>
                </>
              ) : (
                <>
                  <svg className="text-[var(--accent)]" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                  <span className="text-sm text-[var(--accent)]">
                    {generateAssets.isError
                      ? "Retry image generation"
                      : isMultiSlot
                        ? `Generate image ${safeActiveSlot + 1}`
                        : "Generate image variants"}
                  </span>
                </>
              )}
            </button>
          ) : (
            <div className="relative aspect-[16/10] rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--surface-2)]">
              {previewAsset?.signedUrl &&
                (isVideoAsset(previewAsset) ? (
                  <video
                    src={previewAsset.signedUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="absolute inset-0 h-full w-full object-contain bg-black"
                  >
                    <track kind="captions" />
                  </video>
                ) : (
                  <Image
                    src={previewAsset.signedUrl}
                    alt="Variant preview"
                    fill
                    sizes="(max-width: 680px) 100vw, 680px"
                    className="object-contain"
                  />
                ))}
              {renderable.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={handlePrev}
                    aria-label="Previous variant"
                    className="absolute left-2 top-1/2 -translate-y-1/2 grid place-items-center h-9 w-9 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={handleNext}
                    aria-label="Next variant"
                    className="absolute right-2 top-1/2 -translate-y-1/2 grid place-items-center h-9 w-9 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </button>
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-full bg-black/55 text-[11px] text-white">
                    {safePreviewIdx + 1} / {renderable.length}
                    {previewIsCommitted && (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-[var(--success)]">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        selected
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* VARIANT STRIP */}
          {renderable.length > 1 && (
            <div className="mt-3 grid grid-cols-6 gap-2">
              {renderable.map((asset, i) => {
                const isCommitted = asset.id === committedId;
                const isPreviewing = i === safePreviewIdx;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => setPreviewIdxForActive(() => i)}
                    title={isCommitted ? "Currently selected" : "Preview this variant"}
                    className={`relative aspect-square rounded-md overflow-hidden border bg-[var(--surface-2)] transition-all ${
                      isPreviewing
                        ? "border-[var(--accent)] ring-2 ring-[var(--accent)]"
                        : "border-[var(--border)] opacity-70 hover:opacity-100"
                    }`}
                  >
                    {isVideoAsset(asset) ? (
                      <video
                        src={asset.signedUrl!}
                        muted
                        playsInline
                        preload="metadata"
                        className="absolute inset-0 h-full w-full object-cover bg-black"
                      />
                    ) : (
                      <Image
                        src={asset.signedUrl!}
                        alt="Variant thumbnail"
                        fill
                        sizes="80px"
                        className="object-cover"
                      />
                    )}
                    {isCommitted && (
                      <span
                        className="absolute top-1 right-1 grid place-items-center h-3.5 w-3.5 rounded-full text-white"
                        style={{ background: "var(--success)" }}
                        aria-label="Selected"
                      >
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* USE THIS VARIANT / REGENERATE THIS SLOT */}
          {approval.needsImages && renderable.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              {renderable.length > 1 && previewAsset && !previewIsCommitted && (
                <button
                  type="button"
                  onClick={() => selectAsset.mutate({ assetId: previewAsset.id })}
                  disabled={selectAsset.isPending}
                  className="btn btn-secondary btn-sm flex-1"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Use this variant
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  generateAssets.mutate(
                    isMultiSlot
                      ? {
                          contentId: approval.contentId,
                          slotIndex: safeActiveSlot,
                        }
                      : { contentId: approval.contentId },
                    { onSuccess: () => router.refresh() },
                  )
                }
                disabled={generateAssets.isPending}
                className="btn btn-ghost btn-sm flex-1"
                title={
                  isMultiSlot
                    ? `Generate a fresh variant for image ${safeActiveSlot + 1}`
                    : "Generate a fresh variant"
                }
              >
                {generateAssets.isPending ? (
                  <>
                    <svg className="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M21 12a9 9 0 11-6.219-8.56" />
                    </svg>
                    Regenerating…
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1015-6.7L21 8" />
                      <path d="M21 3v5h-5" />
                    </svg>
                    {isMultiSlot ? `Regenerate image ${safeActiveSlot + 1}` : "Regenerate"}
                  </>
                )}
              </button>
            </div>
          )}
        </section>

        {/* AI RATIONALE */}
        {rationale && (
          <section className="px-5 pt-5">
            <div className="section-title flex items-center gap-1.5 text-[var(--violet)]">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 2A2.5 2.5 0 007 4.5v15A2.5 2.5 0 009.5 22h5a2.5 2.5 0 002.5-2.5v-15A2.5 2.5 0 0014.5 2z" />
                <path d="M9 12h6" />
              </svg>
              AI rationale
            </div>
            <p className="mt-2 text-xs text-mid italic leading-relaxed rounded-md p-3 border border-[var(--border)] bg-[var(--violet-soft)]">
              {rationale}
            </p>
          </section>
        )}

        {/* BODY COPY */}
        {bodyCopy && (
          <section className="px-5 pt-5">
            <div className="section-title">Copy preview</div>
            <div className="mt-2 surface p-4 text-[13px] leading-relaxed text-ink">
              {hasMarkers ? (
                bodySegments.map((seg, i) => {
                  if (seg.kind === "text") {
                    if (!seg.value.trim()) return null;
                    return (
                      <p
                        key={`t-${i}`}
                        className="whitespace-pre-wrap mb-3 last:mb-0"
                      >
                        {seg.value.trim()}
                      </p>
                    );
                  }
                  // Body markers map to the post's PUBLISHED images (one per
                  // slot, ordered), not the active-slot's variant strip.
                  // Without this, switching to slot 2 in the carousel would
                  // make the [IMAGE 1] marker render slot 2's preview.
                  const asset = committedBySlot[seg.index];
                  return (
                    <Fragment key={`i-${i}`}>
                      {asset?.signedUrl ? (
                        <figure className="my-3">
                          {isVideoAsset(asset) ? (
                            <video
                              src={asset.signedUrl}
                              controls
                              playsInline
                              preload="metadata"
                              className="w-full h-auto rounded-md border border-[var(--border)] bg-black"
                            >
                              <track kind="captions" />
                            </video>
                          ) : (
                            <Image
                              src={asset.signedUrl}
                              alt={seg.description}
                              width={1024}
                              height={576}
                              className="w-full h-auto rounded-md border border-[var(--border)]"
                            />
                          )}
                          <figcaption className="mt-1 text-[11px] text-mid italic">
                            {seg.description}
                          </figcaption>
                        </figure>
                      ) : (
                        <div className="my-3 rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-2)] p-3 text-[11px] text-mid italic">
                          {approval.needsImages
                            ? generateAssets.isPending
                              ? `Generating image: ${seg.description}`
                              : `Image pending: ${seg.description}`
                            : `Image disabled: ${seg.description}`}
                        </div>
                      )}
                    </Fragment>
                  );
                })
              ) : (
                <pre className="whitespace-pre-wrap mono text-xs">{bodyCopy}</pre>
              )}
            </div>
          </section>
        )}

        {/* GENERATION PROMPT — read-only, helps the reviewer see exactly
            what the model was asked to render. Mirrors gallery / campaign
            detail pages, which already surface promptUsed. */}
        {previewAsset?.promptUsed && (
          <section className="px-5 pt-5 pb-6">
            <div className="section-title flex items-center justify-between gap-2">
              <span>
                Generation prompt
                {renderable.length > 1 && (
                  <span className="ml-2 text-[10.5px] text-faint normal-case">
                    variant {safePreviewIdx + 1}
                  </span>
                )}
              </span>
              <span className="text-[10.5px] text-faint normal-case">read-only</span>
            </div>
            <pre
              className="mt-2 surface p-3 text-[11.5px] leading-relaxed text-mid mono whitespace-pre-wrap wrap-break-word max-h-72 overflow-y-auto select-text"
              aria-label="Image generation prompt (read-only)"
            >
              {previewAsset.promptUsed}
            </pre>
          </section>
        )}
      </div>

      {/* STICKY ACTION BAR */}
      <footer className="px-5 py-3 hairline-t bg-[var(--surface)]">
        {reasonMode ? (
          <div className="flex flex-col gap-2">
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                reasonMode === "rejected"
                  ? "Why are you rejecting this? (captured for the learning loop)"
                  : "What should change? e.g. 'replace the 3D cards with a student photo'"
              }
              className="field flex-1"
            />
            {reasonMode === "changes_requested" && (
              <p className="text-[11px] leading-snug text-[var(--muted)]">
                For image changes, describe what you want differently — subject, mood, or layout.
                Vague feedback (&ldquo;I don&rsquo;t like it&rdquo;) often produces a similar image.
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => decideWith(reasonMode, reason.trim())}
                disabled={!reason.trim() || decide.isPending}
                className={`btn btn-sm flex-1 ${
                  reasonMode === "rejected" ? "btn-danger" : "btn-primary"
                }`}
              >
                {reasonMode === "rejected" ? "Confirm reject" : "Send request"}
              </button>
              <button
                onClick={() => {
                  setReasonMode(null);
                  setReason("");
                }}
                className="btn btn-secondary btn-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => decideWith("approved")}
              disabled={decide.isPending}
              className="btn btn-primary btn-sm flex-1"
              style={{ background: "var(--success)", borderColor: "var(--success)" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Approve
            </button>
            <button
              onClick={() => setReasonMode("changes_requested")}
              disabled={decide.isPending}
              className="btn btn-secondary btn-sm"
            >
              Request changes
            </button>
            <button
              onClick={() => setReasonMode("rejected")}
              disabled={decide.isPending}
              className="btn btn-danger btn-sm"
            >
              Reject
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}
