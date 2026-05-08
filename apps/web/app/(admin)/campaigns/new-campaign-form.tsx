"use client";

import { useState } from "react";
import { useCreateCampaign } from "@/lib/query/use-campaigns";

export function NewCampaignForm() {
  const create = useCreateCampaign();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"buildup" | "launch" | "post_launch">(
    "buildup",
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    create.mutate(
      { slug, name, phase },
      {
        onSuccess: () => {
          setSlug("");
          setName("");
        },
      },
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="grid grid-cols-[1fr_1fr_auto_auto] gap-3 items-end"
    >
      <label className="text-sm flex flex-col gap-1.5">
        <span className="text-xs text-mid uppercase tracking-wider">Slug</span>
        <input
          required
          pattern="[a-z0-9-]+"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="q3-launch"
          className="field"
        />
      </label>
      <label className="text-sm flex flex-col gap-1.5">
        <span className="text-xs text-mid uppercase tracking-wider">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Q3 launch"
          className="field"
        />
      </label>
      <label className="text-sm flex flex-col gap-1.5">
        <span className="text-xs text-mid uppercase tracking-wider">Phase</span>
        <select
          value={phase}
          onChange={(e) =>
            setPhase(e.target.value as "buildup" | "launch" | "post_launch")
          }
          className="field"
        >
          <option value="buildup">buildup</option>
          <option value="launch">launch</option>
          <option value="post_launch">post_launch</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={create.isPending}
        className="btn btn-primary"
      >
        {create.isPending ? "Creating…" : "Create campaign"}
      </button>
      {create.isError && (
        <p className="col-span-4 text-sm text-[var(--danger)]">
          {(create.error as Error).message}
        </p>
      )}
    </form>
  );
}
