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
      className="mb-8 grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-end"
    >
      <label className="text-sm flex flex-col gap-1">
        <span className="text-zinc-500">Slug</span>
        <input
          required
          pattern="[a-z0-9-]+"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="q3-launch"
          className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-2 bg-transparent"
        />
      </label>
      <label className="text-sm flex flex-col gap-1">
        <span className="text-zinc-500">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Q3 launch"
          className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-2 bg-transparent"
        />
      </label>
      <label className="text-sm flex flex-col gap-1">
        <span className="text-zinc-500">Phase</span>
        <select
          value={phase}
          onChange={(e) =>
            setPhase(e.target.value as "buildup" | "launch" | "post_launch")
          }
          className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-2 bg-transparent"
        >
          <option value="buildup">buildup</option>
          <option value="launch">launch</option>
          <option value="post_launch">post_launch</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={create.isPending}
        className="h-[38px] rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 text-sm font-medium disabled:opacity-50"
      >
        {create.isPending ? "Creating…" : "Create"}
      </button>
      {create.isError && (
        <p className="col-span-4 text-sm text-red-600">
          {(create.error as Error).message}
        </p>
      )}
    </form>
  );
}
