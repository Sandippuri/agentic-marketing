"use client";

import { useState, useTransition } from "react";

export type KnowledgeCollection = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  scope: string;
  description: string | null;
};

export type KnowledgeDoc = {
  id: string;
  slug: string;
  title: string;
  status: string;
  source: string;
  version: number;
  updatedAt: string;
};

type DocDetail = KnowledgeDoc & { body: string; metadata: Record<string, unknown> };

export function KnowledgeBrowser({
  initialCollections,
  initialDocs,
}: {
  initialCollections: KnowledgeCollection[];
  initialDocs: KnowledgeDoc[];
}) {
  const [collections, setCollections] = useState(initialCollections);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(
    initialCollections[0]?.id ?? null,
  );
  const [docs, setDocs] = useState<KnowledgeDoc[]>(initialDocs);
  const [activeDoc, setActiveDoc] = useState<DocDetail | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<
    Array<{ documentId: string; title: string; collectionName: string; similarity: number; body: string }>
  >([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function selectCollection(id: string) {
    setActiveCollectionId(id);
    setActiveDoc(null);
    const res = await fetch(`/api/kb/documents?collectionId=${id}&status=active`);
    if (res.ok) setDocs((await res.json()) as KnowledgeDoc[]);
  }

  async function openDoc(id: string) {
    const res = await fetch(`/api/kb/documents/${id}`);
    if (!res.ok) return;
    const json = (await res.json()) as { document: DocDetail };
    setActiveDoc(json.document);
  }

  async function saveDoc(updates: Partial<DocDetail>) {
    if (!activeDoc) return;
    setError(null);
    const res = await fetch(`/api/kb/documents/${activeDoc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updates, ingest: true }),
    });
    if (!res.ok) {
      const text = await res.text();
      setError(text);
      return;
    }
    const json = (await res.json()) as { document: DocDetail };
    setActiveDoc(json.document);
    if (activeCollectionId) await selectCollection(activeCollectionId);
  }

  async function search() {
    if (!searchQuery.trim()) return;
    setError(null);
    const res = await fetch(`/api/kb/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: searchQuery, k: 8 }),
    });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    const hits = (await res.json()) as Array<{
      documentId: string;
      documentTitle: string;
      collectionName: string;
      similarity: number;
      body: string;
    }>;
    setSearchHits(
      hits.map((h) => ({
        documentId: h.documentId,
        title: h.documentTitle,
        collectionName: h.collectionName,
        similarity: h.similarity,
        body: h.body,
      })),
    );
  }

  async function createDoc(form: HTMLFormElement) {
    if (!activeCollectionId) return;
    const fd = new FormData(form);
    const slug = String(fd.get("slug") ?? "").trim();
    const title = String(fd.get("title") ?? "").trim();
    const body = String(fd.get("body") ?? "");
    if (!slug || !title) return;
    const res = await fetch(`/api/kb/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collectionId: activeCollectionId,
        slug,
        title,
        bodyMd: body,
        ingest: true,
      }),
    });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    form.reset();
    await selectCollection(activeCollectionId);
  }

  return (
    <div className="grid grid-cols-[260px_280px_1fr] gap-4">
      <div className="surface p-3 max-h-[calc(100dvh-200px)] overflow-y-auto">
        <div className="section-title px-1 mb-2">Collections</div>
        <ul className="flex flex-col gap-0.5">
          {collections.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => selectCollection(c.id)}
                className={[
                  "w-full text-left rounded-md px-2 py-1.5 text-[13px]",
                  c.id === activeCollectionId
                    ? "bg-[var(--surface-2)] text-ink"
                    : "text-mid hover:text-ink hover:bg-[var(--surface-2)]",
                ].join(" ")}
              >
                <div className="font-medium">{c.name}</div>
                <div className="text-[11px] text-faint">
                  {c.kind} · {c.scope}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 pt-3 border-t border-[var(--border)]">
          <div className="section-title px-1 mb-2">Search</div>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Semantic search…"
            className="w-full rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)] text-ink"
          />
          <button
            className="mt-2 w-full rounded-md px-2 py-1.5 text-[12px] bg-[var(--accent)] text-white"
            onClick={search}
          >
            Search
          </button>
          {searchHits.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {searchHits.map((h, i) => (
                <li
                  key={`${h.documentId}-${i}`}
                  className="rounded-md p-2 bg-[var(--surface-2)] text-[12px]"
                >
                  <button onClick={() => openDoc(h.documentId)} className="text-left">
                    <div className="font-medium text-ink">{h.title}</div>
                    <div className="text-[10.5px] text-faint">
                      {h.collectionName} · {(h.similarity * 100).toFixed(0)}%
                    </div>
                    <div className="text-[11px] text-mid line-clamp-3 mt-1">
                      {h.body.slice(0, 220)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="surface p-3 max-h-[calc(100dvh-200px)] overflow-y-auto">
        <div className="section-title px-1 mb-2">Documents</div>
        <ul className="flex flex-col gap-0.5">
          {docs.map((d) => (
            <li key={d.id}>
              <button
                onClick={() => openDoc(d.id)}
                className={[
                  "w-full text-left rounded-md px-2 py-1.5 text-[13px]",
                  activeDoc?.id === d.id
                    ? "bg-[var(--surface-2)] text-ink"
                    : "text-mid hover:text-ink hover:bg-[var(--surface-2)]",
                ].join(" ")}
              >
                <div className="font-medium">{d.title}</div>
                <div className="text-[11px] text-faint mono">
                  {d.slug} · v{d.version} · {d.status}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-4 pt-3 border-t border-[var(--border)] flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(() => createDoc(e.currentTarget));
          }}
        >
          <div className="section-title px-1">New document</div>
          <input
            name="slug"
            placeholder="slug-kebab"
            className="rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
            required
          />
          <input
            name="title"
            placeholder="Title"
            className="rounded-md px-2 py-1.5 text-[13px] bg-[var(--surface-2)]"
            required
          />
          <textarea
            name="body"
            placeholder="Body (markdown)…"
            className="rounded-md px-2 py-1.5 text-[12px] bg-[var(--surface-2)] mono min-h-[80px]"
          />
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md px-2 py-1.5 text-[12px] bg-[var(--accent)] text-white"
          >
            {isPending ? "Saving…" : "Create"}
          </button>
        </form>
      </div>

      <div className="surface p-5 max-h-[calc(100dvh-200px)] overflow-y-auto">
        {!activeDoc ? (
          <div className="text-mid">Select a document to view & edit.</div>
        ) : (
          <DocumentEditor doc={activeDoc} onSave={saveDoc} error={error} />
        )}
      </div>
    </div>
  );
}

function DocumentEditor({
  doc,
  onSave,
  error,
}: {
  doc: DocDetail;
  onSave: (updates: Partial<DocDetail>) => Promise<void>;
  error: string | null;
}) {
  const [title, setTitle] = useState(doc.title);
  const [body, setBody] = useState(doc.body);
  const [status, setStatus] = useState(doc.status);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSave({ title, bodyMd: body, status, bumpVersion: true } as Partial<DocDetail>);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 text-[18px] font-semibold tracking-tight bg-transparent outline-none border-b border-[var(--border)] py-1"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md px-2 py-1 text-[12px] bg-[var(--surface-2)]"
        >
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="archived">archived</option>
        </select>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md px-3 py-1.5 text-[12px] bg-[var(--accent)] text-white"
        >
          {saving ? "Saving…" : "Save & re-embed"}
        </button>
      </div>
      <div className="text-[11px] text-faint mono">
        slug: {doc.slug} · v{doc.version} · source: {doc.source}
      </div>
      {error && (
        <div className="rounded-md p-2 bg-[var(--error-bg, #2a1313)] text-[12px]">{error}</div>
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="w-full min-h-[60vh] rounded-md p-3 text-[13px] bg-[var(--surface-2)] mono"
      />
    </div>
  );
}
