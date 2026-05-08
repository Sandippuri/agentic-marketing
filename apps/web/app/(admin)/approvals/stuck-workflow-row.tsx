"use client";

import { useRouter } from "next/navigation";
import { useResumeStuckHook } from "@/lib/query/use-approvals";

export type StuckWorkflow = {
  approvalId: string;
  contentId: string;
  contentTitle: string;
  contentType: string;
  campaignName: string;
  decision: "approved" | "changes_requested" | "rejected";
  decidedAt: string;
  reason: string | null;
  workflowRunId: string;
  engineRunRef: string | null;
  ageLabel: string;
};

const DECISION_TONE: Record<StuckWorkflow["decision"], string> = {
  approved: "badge-success",
  changes_requested: "badge-warn",
  rejected: "badge-danger",
};

export function StuckWorkflowRow({ run }: { run: StuckWorkflow }) {
  const router = useRouter();
  const resume = useResumeStuckHook();

  function handleResume() {
    resume.mutate(
      { approvalId: run.approvalId },
      { onSuccess: () => router.refresh() },
    );
  }

  return (
    <li className="flex items-center gap-4 px-5 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium text-ink truncate">
          {run.contentTitle}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="badge badge-neutral">{run.contentType}</span>
          <span className={`badge ${DECISION_TONE[run.decision]}`}>
            {run.decision.replace("_", " ")}
          </span>
          <span className="badge badge-neutral" title={new Date(run.decidedAt).toLocaleString()}>
            decided {run.ageLabel}
          </span>
          {run.engineRunRef && (
            <span className="text-[11px] text-faint font-mono">
              {run.engineRunRef}
            </span>
          )}
        </div>
        {run.reason && (
          <div className="mt-1 text-xs text-mid line-clamp-1" title={run.reason}>
            “{run.reason}”
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-2">
        <button
          type="button"
          onClick={handleResume}
          disabled={resume.isPending}
          className="btn btn-secondary btn-sm"
          title="Re-fire the approval hook so the workflow can advance"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-3-6.7" />
            <path d="M21 4v5h-5" />
          </svg>
          {resume.isPending ? "Resuming…" : "Re-fire hook"}
        </button>
      </div>

      {resume.isError && (
        <span className="ml-2 text-xs text-[var(--danger)]">
          {(resume.error as Error).message}
        </span>
      )}
    </li>
  );
}
