"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

export type ApprovalDecisionInput = {
  approvalId: string;
  decision: "approved" | "changes_requested" | "rejected";
  reason?: string;
};

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ approvalId, ...body }: ApprovalDecisionInput) => {
      const res = await fetch(`/api/approvals/${approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `POST -> ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}
