"use client";

import { useState } from "react";
import Image from "next/image";
import { useDecideApproval } from "@/lib/query/use-approvals";

export type PendingApproval = {
  id: string;
  contentId: string;
  contentTitle: string;
  contentType: string;
  contentStage: string;
  requestedAt: string;
  ageLabel?: string;
  /** Signed URL for the associated visual asset, if any */
  assetSignedUrl?: string | null;
  /** Markdown body preview */
  bodyMd?: string | null;
};

export function ApprovalRow({ approval }: { approval: PendingApproval }) {
  const decide = useDecideApproval();
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const meta = (
    <div className="text-xs text-zinc-500 mt-1 flex items-center gap-2 flex-wrap">
      <span>{approval.contentType}</span>
      <span>·</span>
      <span className="capitalize">{approval.contentStage}</span>
      <span>·</span>
      <span
        className={
          approval.ageLabel?.includes("d")
            ? "text-amber-600 dark:text-amber-400 font-medium"
            : ""
        }
      >
        {approval.ageLabel ?? new Date(approval.requestedAt).toLocaleString()}
      </span>
    </div>
  );

  const copyPreview = approval.bodyMd ? (
    <div className="mt-1">
      <button
        onClick={() => setExpanded((s) => !s)}
        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        {expanded ? "Hide copy ↑" : "Preview copy ↓"}
      </button>
      {expanded && (
        <pre className="mt-1 text-xs whitespace-pre-wrap leading-relaxed bg-zinc-50 dark:bg-zinc-800/60 rounded p-2 max-h-48 overflow-y-auto border border-zinc-200 dark:border-zinc-700">
          {approval.bodyMd}
        </pre>
      )}
    </div>
  ) : null;

  const actions = (
    <div className="flex gap-2 flex-wrap mt-2">
      <button
        onClick={() => decide.mutate({ approvalId: approval.id, decision: "approved" })}
        disabled={decide.isPending}
        className="rounded bg-emerald-600 text-white px-3 py-1 text-sm font-medium disabled:opacity-50"
      >
        Approve
      </button>
      <button
        onClick={() => setShowReason((s) => !s)}
        className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm"
      >
        Request changes
      </button>
      <button
        onClick={() =>
          decide.mutate({
            approvalId: approval.id,
            decision: "rejected",
            reason: reason || undefined,
          })
        }
        disabled={decide.isPending}
        className="rounded bg-red-600 text-white px-3 py-1 text-sm font-medium disabled:opacity-50"
      >
        Reject
      </button>
    </div>
  );

  return (
    <li className="py-3">
      {approval.assetSignedUrl ? (
        /* Side-by-side layout when a visual asset is attached */
        <div className="flex gap-4">
          <div className="shrink-0 w-40 h-40 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800">
            <Image
              src={approval.assetSignedUrl}
              alt="Asset preview"
              width={160}
              height={160}
              className="object-cover w-full h-full"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{approval.contentTitle}</div>
            {meta}
            {copyPreview}
            {actions}
          </div>
        </div>
      ) : (
        /* Text-only layout */
        <div>
          <div className="text-sm font-medium">{approval.contentTitle}</div>
          {meta}
          {copyPreview}
          {actions}
        </div>
      )}

      {showReason && (
        <div className="mt-3 flex gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What needs to change?"
            className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm bg-transparent"
          />
          <button
            onClick={() =>
              decide.mutate({
                approvalId: approval.id,
                decision: "changes_requested",
                reason,
              })
            }
            disabled={!reason || decide.isPending}
            className="rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            Send
          </button>
        </div>
      )}

      {decide.isError && (
        <p className="mt-2 text-xs text-red-600">{(decide.error as Error).message}</p>
      )}
    </li>
  );
}
