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
      className="rounded border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50"
    >
      {isPending ? "Approving…" : `Approve all ${approvalIds.length}`}
    </button>
  );
}
