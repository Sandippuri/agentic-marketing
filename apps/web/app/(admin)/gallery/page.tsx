import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { ASSET_KINDS, ASSET_STATUSES } from "@marketing/shared-types";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { isVideoAsset } from "@/lib/asset-media";
import { getWorkspaceContext } from "@/lib/billing";
import { PageHeader, Badge, EmptyState, statusTone } from "../ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();
  const ctx = await getWorkspaceContext();
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = 24;
  const offset = (page - 1) * pageSize;

  const conditions = [eq(schema.assets.workspaceId, ctx.workspaceId)];
  if (params.kind) conditions.push(eq(schema.assets.kind, params.kind as never));
  if (params.status) conditions.push(eq(schema.assets.status, params.status as never));

  const where = and(...conditions);

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: schema.assets.id,
        kind: schema.assets.kind,
        status: schema.assets.status,
        storagePath: schema.assets.storagePath,
        promptUsed: schema.assets.promptUsed,
        templateId: schema.assets.templateId,
        mimeType: schema.assets.mimeType,
        createdAt: schema.assets.createdAt,
        contentId: schema.assets.contentId,
        contentTitle: schema.contentItems.title,
        campaignId: schema.contentItems.campaignId,
        campaignName: schema.campaigns.name,
      })
      .from(schema.assets)
      .leftJoin(schema.contentItems, eq(schema.assets.contentId, schema.contentItems.id))
      .leftJoin(schema.campaigns, eq(schema.contentItems.campaignId, schema.campaigns.id))
      .where(where)
      .orderBy(desc(schema.assets.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.assets)
      .where(where),
  ]);

  const signed = await Promise.all(
    rows.map(async (r) => {
      const url = await getSignedAssetUrl(r.storagePath).catch(() => null);
      return { ...r, signedUrl: url };
    }),
  );

  const total = countResult[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const buildHref = (overrides: Record<string, string | undefined>) => {
    const merged = { ...params, ...overrides };
    const qs = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join("&");
    return qs ? `?${qs}` : "?";
  };

  return (
    <div>
      <PageHeader
        title="Gallery"
        description="Generated visuals across every campaign and channel."
        meta={
          <Badge tone="neutral">
            {total} asset{total === 1 ? "" : "s"}
          </Badge>
        }
      />

      {/* Filters */}
      <div className="surface mb-5 px-3 py-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">Kind</span>
        <FilterPill label="All" href={buildHref({ kind: undefined, page: undefined })} active={!params.kind} />
        {ASSET_KINDS.map((k) => (
          <FilterPill
            key={k}
            label={k}
            href={buildHref({ kind: k, page: undefined })}
            active={params.kind === k}
          />
        ))}
        <span className="h-5 w-px bg-[var(--border)] mx-1" />
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">Status</span>
        <FilterPill label="All" href={buildHref({ status: undefined, page: undefined })} active={!params.status} />
        {ASSET_STATUSES.map((s) => (
          <FilterPill
            key={s}
            label={s}
            href={buildHref({ status: s, page: undefined })}
            active={params.status === s}
          />
        ))}
        {(params.kind || params.status) && (
          <a
            href="?"
            className="btn btn-ghost btn-sm ml-auto"
          >
            Reset
          </a>
        )}
      </div>

      {signed.length === 0 ? (
        <EmptyState
          title="No assets yet"
          description="Generated images and videos will appear here as soon as the asset agent ships its first run."
          icon={
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {signed.map((a) => (
            <article
              key={a.id}
              className="surface overflow-hidden flex flex-col group hover:border-[var(--border-strong)] transition-colors"
              style={{ padding: 0 }}
            >
              <div className="aspect-square bg-[var(--surface-2)] relative">
                {a.signedUrl ? (
                  <a href={a.signedUrl} target="_blank" rel="noopener noreferrer">
                    {isVideoAsset(a) ? (
                      <video
                        src={a.signedUrl}
                        muted
                        playsInline
                        preload="metadata"
                        controls
                        className="absolute inset-0 w-full h-full object-cover bg-black"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.signedUrl}
                        alt={a.contentTitle ?? a.kind}
                        className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                      />
                    )}
                  </a>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-faint">
                    preview unavailable
                  </div>
                )}
                <div className="absolute inset-x-0 top-0 p-2 flex items-center justify-between">
                  <Badge tone={statusTone(a.status)} dot>
                    {a.status}
                  </Badge>
                  <span className="badge bg-black/70 text-white border-transparent backdrop-blur-sm">
                    {a.kind}
                  </span>
                </div>
              </div>
              <div className="p-3 flex flex-col gap-1 text-sm border-t border-[var(--border)]">
                <div
                  className="font-medium text-ink truncate"
                  title={a.contentTitle ?? undefined}
                >
                  {a.contentTitle ?? <span className="text-faint italic">Unlinked</span>}
                </div>
                {a.campaignName && (
                  <div className="text-xs text-mid truncate">{a.campaignName}</div>
                )}
                {a.promptUsed && (
                  <p
                    className="mt-1 text-[11.5px] text-low line-clamp-2 leading-snug"
                    title={a.promptUsed}
                  >
                    {a.promptUsed}
                  </p>
                )}
                <div className="mt-1 text-[10.5px] text-faint mono">
                  {new Date(a.createdAt).toLocaleString()}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between text-sm">
          <span className="text-mid">
            Page <span className="text-ink font-medium">{page}</span> of {totalPages}
          </span>
          <div className="flex gap-2">
            <a
              href={buildHref({ page: String(Math.max(1, page - 1)) })}
              className={`btn btn-secondary btn-sm ${page <= 1 ? "pointer-events-none opacity-50" : ""}`}
            >
              ← Previous
            </a>
            <a
              href={buildHref({ page: String(Math.min(totalPages, page + 1)) })}
              className={`btn btn-secondary btn-sm ${page >= totalPages ? "pointer-events-none opacity-50" : ""}`}
            >
              Next →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterPill({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <a
      href={href}
      className={[
        "px-2.5 py-1 text-[12px] rounded-md border transition-colors",
        active
          ? "bg-[var(--bg-elevated)] text-ink border-[var(--border-strong)] shadow-sm"
          : "bg-transparent text-mid border-transparent hover:text-ink hover:bg-[var(--surface-2)]",
      ].join(" ")}
    >
      {label}
    </a>
  );
}
