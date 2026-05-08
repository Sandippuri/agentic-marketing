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

export function useResumeStuckHook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ approvalId }: { approvalId: string }) => {
      const res = await fetch(`/api/approvals/${approvalId}/resume`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `POST -> ${res.status}`);
      }
      return res.json() as Promise<{ ok: true; decision: string }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals"] });
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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `POST -> ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals"] });
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
      title?: string;
      bodyMd?: string;
    }) => {
      const res = await fetch(`/api/content/${contentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `PATCH -> ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

export function useGenerateAssets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contentId }: { contentId: string }) => {
      const res = await fetch(`/api/content/${contentId}/generate-assets`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `POST -> ${res.status}`);
      }
      return res.json() as Promise<{ inserted: number }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}
