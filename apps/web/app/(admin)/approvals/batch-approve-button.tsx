"use client";

import { useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

type Props = { approvalIds: string[] };

export function BatchApproveButton({ approvalIds }: Props) {
  const [isPending, startTransition] = useTransition();
  const qc = useQueryClient();
  const router = useRouter();

  function handleBatchApprove() {
    startTransition(async () => {
      await Promise.allSettled(
        approvalIds.map((id) =>
          fetch(`/api/approvals/${id}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision: "approved" }),
          }),
        ),
      );
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      router.refresh();
    });
  }

  return (
    <button
      onClick={handleBatchApprove}
      disabled={isPending}
      className="btn btn-secondary btn-sm"
      style={{
        color: "var(--success)",
        borderColor: "var(--success)",
      }}
    >
      {isPending ? (
        <svg className="spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M21 12a9 9 0 11-6.219-8.56" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
      {isPending ? "Approving…" : `Approve all ${approvalIds.length}`}
    </button>
  );
}
