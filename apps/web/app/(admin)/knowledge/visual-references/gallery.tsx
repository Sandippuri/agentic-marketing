"use client";

import { useState, useTransition } from "react";

export type VisualRef = {
  id: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  tags: string[];
  useFor: string[];
  caption: string;
  updatedAt: string;
};

export type VisualRefGroup = {
  collectionId: string;
  collectionSlug: string;
  collectionName: string;
  docs: VisualRef[];
};

export function VisualReferenceGallery({
  groups: initialGroups,
}: {
  groups: VisualRefGroup[];
}) {
  const [groups, setGroups] = useState(initialGroups);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [showForm, setShowForm] = useState(initialGroups.length === 0);

  async function refresh() {
    const res = await fetch("/api/kb/visual-references");
    if (res.ok) setGroups((await res.json()) as VisualRefGroup[]);
  }

  async function submit(form: HTMLFormElement) {
    setError(null);
    const fd = new FormData(form);
    const body = {
      collectionSlug: String(fd.get("collectionSlug") ?? "visual-references"),
      collectionName: String(fd.get("collectionName") ?? "Visual References"),
      slug: String(fd.get("slug") ?? "").trim(),
      title: String(fd.get("title") ?? "").trim(),
      imageUrl: String(fd.get("imageUrl") ?? "").trim(),
      caption: String(fd.get("caption") ?? "").trim(),
      tags: String(fd.get("tags") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      useFor: String(fd.get("useFor") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (!body.slug || !body.title || !body.imageUrl || !body.caption) {
      setError("slug, title, imageUrl, caption are required");
      return;
    }
    const res = await fetch("/api/kb/visual-references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    form.reset();
    setShowForm(false);
    await refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md px-3 py-1.5 text-[12px] bg-[var(--accent)] text-white"
        >
          {showForm ? "Cancel" : "Add reference"}
        </button>
      </div>

      {showForm && (
        <form
          className="surface p-4 grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(() => submit(e.currentTarget));
          }}
        >
          <input
            name="collectionSlug"
            placeholder="collection slug (default: visual-references)"
            defaultValue="visual-references"
            className="rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
          />
          <input
            name="collectionName"
            placeholder="collection name"
            defaultValue="Visual References"
            className="rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
          />
          <input
            name="slug"
            placeholder="slug-kebab"
            className="rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
            required
          />
          <input
            name="title"
            placeholder="Title (e.g. Aleo bridge UI hero)"
            className="rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
            required
          />
          <input
            name="imageUrl"
            placeholder="https://… (Supabase signed URL or public URL)"
            className="col-span-2 rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
            required
          />
          <input
            name="tags"
            placeholder="tags (comma-separated): bridge,ui,product"
            className="rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
          />
          <input
            name="useFor"
            placeholder="use for (comma): product hero, architecture diagram"
            className="rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
          />
          <textarea
            name="caption"
            placeholder="Caption (markdown) — describe what this image shows AND when to use it. The Art Director reads this to decide whether to pull this reference."
            className="col-span-2 rounded-md p-2 text-[12px] bg-[var(--surface-2)] mono min-h-[100px]"
            required
          />
          {error && (
            <div className="col-span-2 rounded-md p-2 bg-[var(--error-bg, #2a1313)] text-[12px]">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={isPending}
            className="col-span-2 rounded-md px-3 py-1.5 text-[12px] bg-[var(--accent)] text-white"
          >
            {isPending ? "Saving + embedding…" : "Save reference"}
          </button>
        </form>
      )}

      {groups.length === 0 ? (
        <div className="surface p-8 text-center text-mid">
          No visual references yet. Add real product UI captures, brand photography,
          architecture diagrams, signature visual motifs, and approved past assets
          here. The Art Director sub-agent uses these as conditioning for every
          generated image.
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.collectionId} className="flex flex-col gap-2">
            <div className="section-title px-1">{g.collectionName}</div>
            <div className="grid grid-cols-3 gap-3">
              {g.docs.map((d) => (
                <article
                  key={d.id}
                  className="surface p-3 flex flex-col gap-2"
                >
                  {d.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={d.imageUrl}
                      alt={d.title}
                      className="w-full aspect-[4/3] object-cover rounded-md bg-[var(--surface-2)]"
                    />
                  ) : (
                    <div className="w-full aspect-[4/3] rounded-md bg-[var(--surface-2)] grid place-items-center text-faint text-[12px]">
                      no image_url
                    </div>
                  )}
                  <div className="font-medium text-[13px]">{d.title}</div>
                  <div className="text-[11px] text-faint mono">{d.slug}</div>
                  <div className="text-[11px] text-mid line-clamp-3">
                    {d.caption}
                  </div>
                  {d.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {d.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10.5px] text-mid"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {d.useFor.length > 0 && (
                    <div className="text-[10.5px] text-faint">
                      use for: {d.useFor.join(", ")}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
