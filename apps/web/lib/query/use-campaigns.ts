"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type Campaign = {
  id: string;
  slug: string;
  name: string;
  status: string;
  phase: string;
  createdAt: string;
};

const KEY = ["campaigns"] as const;

export function useCampaigns(initialData?: Campaign[]) {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch("/api/campaigns");
      if (!res.ok) throw new Error(`GET /api/campaigns -> ${res.status}`);
      return (await res.json()) as Campaign[];
    },
    initialData,
  });
}

export type CreateCampaignInput = {
  slug: string;
  name: string;
  phase?: "buildup" | "launch" | "post_launch";
  briefMd?: string;
};

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCampaignInput) => {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `POST /api/campaigns -> ${res.status}`);
      }
      return (await res.json()) as Campaign;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export type UpdateCampaignInput = {
  name?: string;
  phase?: "buildup" | "launch" | "post_launch";
  status?: "draft" | "active" | "paused" | "completed" | "archived";
  briefMd?: string;
};

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: { id: string } & UpdateCampaignInput) => {
      const res = await fetch(`/api/campaigns/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `PATCH /api/campaigns/${id} -> ${res.status}`);
      }
      return (await res.json()) as Campaign;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/campaigns/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `DELETE /api/campaigns/${id} -> ${res.status}`);
      }
      return id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
