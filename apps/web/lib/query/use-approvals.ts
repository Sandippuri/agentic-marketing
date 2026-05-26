"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export type ApprovalDecisionInput = {
  approvalId: string;
  decision: "approved" | "changes_requested" | "rejected";
  reason?: string;
};

// Servers return { error, message?, ... }. Prefer the human-readable message
// so the toast tells the reviewer something they can act on.
async function readError(res: Response, fallbackVerb: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    name?: string;
  };
  const label =
    body.message ||
    [body.name, body.error].filter(Boolean).join(": ") ||
    `${fallbackVerb} failed (${res.status})`;
  return new Error(label);
}

const DECISION_VERB: Record<ApprovalDecisionInput["decision"], string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
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
      if (!res.ok) throw await readError(res, "Decide");
      return res.json() as Promise<{
        hookResumed?: boolean;
        hookError?: string | null;
      }>;
    },
    onSuccess: (data, variables) => {
      const verb = DECISION_VERB[variables.decision];
      if (data?.hookResumed === false) {
        toast.warning(`${verb}, but workflow didn't resume`, {
          description:
            data.hookError ??
            "The decision was saved but the workflow hook failed to resume. Use the stuck workflows section to retry.",
        });
      } else {
        toast.success(verb);
      }
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (err: Error, variables) => {
      toast.error(`${DECISION_VERB[variables.decision]} failed`, {
        description: err.message,
      });
    },
  });
}

export function useResumeStuckHook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ approvalId }: { approvalId: string }) => {
      const res = await fetch(`/api/approvals/${approvalId}/resume`, {
        method: "POST",
      });
      if (!res.ok) throw await readError(res, "Resume");
      return res.json() as Promise<{
        ok: true;
        decision: string;
        reconciled?: boolean;
        terminalStatus?: "completed" | "cancelled";
        note?: string;
      }>;
    },
    onSuccess: (data) => {
      if (data.note === "workflow_in_flight") {
        toast.info("Workflow is still revising", {
          description:
            "The revision is in flight — refresh in a minute to see the new approval row.",
        });
      } else if (data.note === "newer_pending_approval_exists") {
        toast.info("Revision already submitted", {
          description: "A new approval row is waiting for you in the queue.",
        });
      } else {
        toast.success(
          data.reconciled
            ? `Reconciled (${data.terminalStatus ?? "completed"})`
            : "Workflow resumed",
        );
      }
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err: Error) => {
      toast.error("Resume failed", { description: err.message });
    },
  });
}

export function useSelectAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ assetId }: { assetId: string }) => {
      const res = await fetch(`/api/assets/${assetId}/select`, {
        method: "POST",
      });
      if (!res.ok) throw await readError(res, "Select");
      return res.json();
    },
    onSuccess: () => {
      toast.success("Variant selected");
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err: Error) => {
      toast.error("Couldn't select variant", { description: err.message });
    },
  });
}

export function useUpdateContent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      contentId,
      ...patch
    }: {
      contentId: string;
      needsImages?: boolean;
      needsVideo?: boolean;
      title?: string;
      bodyMd?: string;
    }) => {
      const res = await fetch(`/api/content/${contentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw await readError(res, "Update");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err: Error) => {
      toast.error("Couldn't update content", { description: err.message });
    },
  });
}

export function useGenerateAssets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      contentId,
      slotIndex,
    }: {
      contentId: string;
      /** Omit to regenerate every slot; set to scope the regen to one image slot. */
      slotIndex?: number;
    }) => {
      const res = await fetch(`/api/content/${contentId}/generate-assets`, {
        method: "POST",
        headers:
          slotIndex != null
            ? { "content-type": "application/json" }
            : undefined,
        body: slotIndex != null ? JSON.stringify({ slotIndex }) : undefined,
      });
      if (!res.ok) throw await readError(res, "Generate");
      return res.json() as Promise<{ inserted: number }>;
    },
    onSuccess: (data, variables) => {
      const noun =
        variables.slotIndex != null
          ? `slot ${variables.slotIndex + 1}`
          : data?.inserted === 1
            ? "variant"
            : "variants";
      toast.success(
        data?.inserted
          ? variables.slotIndex != null
            ? `Regenerated ${noun}`
            : `Generated ${data.inserted} ${noun}`
          : "Generation started",
      );
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err: Error) => {
      toast.error("Generation failed", { description: err.message });
    },
  });
}
