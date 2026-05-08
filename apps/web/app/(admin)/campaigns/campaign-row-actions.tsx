"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDeleteCampaign, useUpdateCampaign } from "@/lib/query/use-campaigns";

type Phase = "buildup" | "launch" | "post_launch";
type Status = "draft" | "active" | "paused" | "completed" | "archived";

const PHASES: Phase[] = ["buildup", "launch", "post_launch"];
const STATUSES: Status[] = ["draft", "active", "paused", "completed", "archived"];

export function CampaignRowActions({
  campaign,
}: {
  campaign: { id: string; name: string; phase: string; status: string };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const update = useUpdateCampaign();
  const del = useDeleteCampaign();

  const [name, setName] = useState(campaign.name);
  const [phase, setPhase] = useState<Phase>(campaign.phase as Phase);
  const [status, setStatus] = useState<Status>(campaign.status as Status);

  function openEdit() {
    setName(campaign.name);
    setPhase(campaign.phase as Phase);
    setStatus(campaign.status as Status);
    setEditing(true);
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    update.mutate(
      { id: campaign.id, name, phase, status },
      {
        onSuccess: () => {
          setEditing(false);
          router.refresh();
        },
      },
    );
  }

  function remove() {
    const ok = window.confirm(
      `Delete campaign "${campaign.name}"? All content items, brand memory, and design system entries scoped to it will be removed.`,
    );
    if (!ok) return;
    del.mutate(campaign.id, {
      onSuccess: () => router.refresh(),
    });
  }

  return (
    <>
      <div className="inline-flex items-center gap-1 justify-end">
        <button
          type="button"
          onClick={openEdit}
          className="btn btn-ghost btn-xs"
          aria-label={`Edit ${campaign.name}`}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={del.isPending}
          className="btn btn-danger btn-xs"
          aria-label={`Delete ${campaign.name}`}
        >
          {del.isPending ? "Deleting…" : "Delete"}
        </button>
      </div>

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => !update.isPending && setEditing(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={save}
            className="surface w-full max-w-md p-5 rounded-lg shadow-xl"
          >
            <h2 className="text-base font-medium mb-1">Edit campaign</h2>
            <p className="text-xs text-mid mono mb-4">{campaign.id}</p>

            <label className="text-sm flex flex-col gap-1.5 mb-3">
              <span className="text-xs text-mid uppercase tracking-wider">Name</span>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="field"
              />
            </label>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <label className="text-sm flex flex-col gap-1.5">
                <span className="text-xs text-mid uppercase tracking-wider">Phase</span>
                <select
                  value={phase}
                  onChange={(e) => setPhase(e.target.value as Phase)}
                  className="field"
                >
                  {PHASES.map((p) => (
                    <option key={p} value={p}>
                      {p.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm flex flex-col gap-1.5">
                <span className="text-xs text-mid uppercase tracking-wider">Status</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Status)}
                  className="field"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {update.isError && (
              <p className="text-sm text-[var(--danger)] mb-3">
                {(update.error as Error).message}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={update.isPending}
                className="btn btn-ghost btn-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={update.isPending}
                className="btn btn-primary btn-sm"
              >
                {update.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
