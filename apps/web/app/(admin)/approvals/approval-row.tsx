"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useDecideApproval } from "@/lib/query/use-approvals";
import { isVideoAsset } from "@/lib/asset-media";

export type AssetOption = {
  id: string;
  signedUrl: string | null;
  status: string;
  kind: string;
  mimeType: string | null;
  /** Final image/video generation prompt sent to the model, surfaced read-only in the detail panel. */
  promptUsed: string | null;
  /**
   * Which image slot this asset fills on the parent content_item (0-based).
   * Multi-image posts surface one approved asset per slot in the detail
   * panel; per-slot variant carousels group draft rows by this index.
   */
  sequenceOrder: number;
};

export type PendingApproval = {
  id: string;
  contentId: string;
  contentTitle: string;
  contentType: string;
  contentStage: string;
  requestedAt: string;
  ageLabel?: string;
  /** Visual variants generated for this post; admin picks one */
  assets: AssetOption[];
  /** Markdown body preview */
  bodyMd?: string | null;
  /** Whether image generation is enabled for this post */
  needsImages: boolean;
  /** Whether video generation is enabled for this post */
  needsVideo: boolean;
};

export function ApprovalRow({
  approval,
  isSelected,
  onOpen,
}: {
  approval: PendingApproval;
  isSelected: boolean;
  onOpen: () => void;
}) {
  const router = useRouter();
  const decide = useDecideApproval();

  const renderable = approval.assets.filter((a) => a.signedUrl);
  // Slot 0 is the canonical lead/cover — show its approved variant in the
  // row thumbnail, not whatever asset happens to be approved first across
  // all slots. Falls back to the first renderable slot if 0 isn't present.
  const slotZero = renderable.filter((a) => (a.sequenceOrder ?? 0) === 0);
  const leadPool = slotZero.length > 0 ? slotZero : renderable;
  const selected =
    leadPool.find((a) => a.status === "approved") ?? leadPool[0] ?? null;
  // Distinct slot count for the "+N images" badge — count slots, not
  // variants. A 1-slot post with 4 variants should still show 1 image, not 4.
  const slotCount = new Set(
    renderable.map((a) => a.sequenceOrder ?? 0),
  ).size;
  const isStale = approval.ageLabel?.includes("d");

  function handleApprove() {
    decide.mutate(
      { approvalId: approval.id, decision: "approved" },
      { onSuccess: () => router.refresh() },
    );
  }

  function handleKey(e: React.KeyboardEvent<HTMLLIElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKey}
      aria-label={`Open ${approval.contentTitle} for review`}
      className={`group flex items-center gap-4 px-5 py-3 cursor-pointer transition-colors outline-none focus-visible:bg-[var(--surface-2)] ${
        isSelected ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]"
      }`}
    >
      {/* THUMBNAIL */}
      <div className="shrink-0 relative w-16 h-16 rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--surface-2)] grid place-items-center">
        {!approval.needsImages ? (
          <svg className="text-faint" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Images disabled">
            <path d="M3 3l18 18" />
            <path d="M21 16V5a2 2 0 00-2-2H7" />
            <path d="M3 7v12a2 2 0 002 2h12" />
          </svg>
        ) : selected?.signedUrl ? (
          <>
            {isVideoAsset(selected) ? (
              <video
                src={selected.signedUrl}
                muted
                playsInline
                preload="metadata"
                className="h-full w-full object-cover bg-black"
              />
            ) : (
              <Image
                src={selected.signedUrl}
                alt=""
                fill
                sizes="64px"
                className="object-cover"
              />
            )}
            {(slotCount > 1 || renderable.length > 1) && (
              <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded-full bg-black/60 text-white text-[9px] font-medium leading-none">
                {slotCount > 1
                  ? `+${slotCount - 1} img`
                  : `+${renderable.length - 1}`}
              </span>
            )}
          </>
        ) : (
          <svg className="text-[var(--warn)]" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Images pending">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        )}
      </div>

      {/* BODY */}
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium text-ink truncate">
          {approval.contentTitle}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="badge badge-neutral">{approval.contentType}</span>
          <span className="badge badge-info capitalize">{approval.contentStage}</span>
          <span
            className={`badge ${isStale ? "badge-warn" : "badge-neutral"}`}
            title={new Date(approval.requestedAt).toLocaleString()}
          >
            {approval.ageLabel ?? new Date(approval.requestedAt).toLocaleString()}
          </span>
          {!approval.needsImages ? (
            <span className="text-[11px] text-faint">images off</span>
          ) : renderable.length === 0 ? (
            <span className="text-[11px] text-[var(--warn)]">images pending</span>
          ) : (
            <span className="text-[11px] text-faint">
              {slotCount > 1
                ? `${slotCount} images · ${renderable.length} variants`
                : `${renderable.length} ${renderable.length === 1 ? "variant" : "variants"}`}
            </span>
          )}
        </div>
      </div>

      {/* ACTIONS — stop propagation so button clicks don't open the panel */}
      <div
        className="shrink-0 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleApprove}
          disabled={decide.isPending}
          className="btn btn-primary btn-sm"
          style={{ background: "var(--success)", borderColor: "var(--success)" }}
          title="Approve without opening details"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Approve
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="btn btn-secondary btn-sm"
          aria-label="Open details"
          title="Review details"
        >
          Review
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

    </li>
  );
}
