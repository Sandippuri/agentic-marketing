import Link from "next/link";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  CONTENT_TYPES,
  CONTENT_STATUSES,
  CONTENT_STAGES,
  parseRationale,
  type ContentType,
  type ContentStatus,
  type ContentStage,
} from "@marketing/shared-types";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { isVideoAsset } from "@/lib/asset-media";
import { getWorkspaceContext } from "@/lib/billing";
import { PageHeader, Badge, EmptyState, statusTone } from "../ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAGE_SIZE = 20;

const STAGE_DOT: Record<string, string> = {
  pull: "bg-sky-500",
  explain: "bg-violet-500",
  reinforce: "bg-amber-500",
  push: "bg-emerald-500",
};

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{
    type?: string;
    status?: string;
    stage?: string;
    campaign?: string;
    has_image?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const db = getDb();
  const ctx = await getWorkspaceContext();

  const page = Math.max(1, Number(params.page ?? 1));
  const offset = (page - 1) * PAGE_SIZE;

  const conditions = [eq(schema.contentItems.workspaceId, ctx.workspaceId)];
  if (params.type && (CONTENT_TYPES as readonly string[]).includes(params.type)) {
    conditions.push(eq(schema.contentItems.type, params.type as ContentType));
  }
  if (params.status && (CONTENT_STATUSES as readonly string[]).includes(params.status)) {
    conditions.push(eq(schema.contentItems.status, params.status as ContentStatus));
  }
  if (params.stage && (CONTENT_STAGES as readonly string[]).includes(params.stage)) {
    conditions.push(eq(schema.contentItems.stage, params.stage as ContentStage));
  }
  if (params.campaign) {
    conditions.push(eq(schema.contentItems.campaignId, params.campaign));
  }
  if (params.has_image === "1") {
    conditions.push(
      sql`exists (select 1 from ${schema.assets} where ${schema.assets.contentId} = ${schema.contentItems.id})`,
    );
  }

  const where = and(...conditions);

  const [rows, countResult, campaignOptions] = await Promise.all([
    db
      .select({
        id: schema.contentItems.id,
        title: schema.contentItems.title,
        bodyMd: schema.contentItems.bodyMd,
        type: schema.contentItems.type,
        stage: schema.contentItems.stage,
        status: schema.contentItems.status,
        scheduledFor: schema.contentItems.scheduledFor,
        publishedAt: schema.contentItems.publishedAt,
        publishedUrl: schema.contentItems.publishedUrl,
        createdAt: schema.contentItems.createdAt,
        updatedAt: schema.contentItems.updatedAt,
        campaignId: schema.contentItems.campaignId,
        campaignName: schema.campaigns.name,
        campaignSlug: schema.campaigns.slug,
      })
      .from(schema.contentItems)
      .leftJoin(
        schema.campaigns,
        eq(schema.contentItems.campaignId, schema.campaigns.id),
      )
      .where(where)
      .orderBy(desc(schema.contentItems.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.contentItems)
      .where(where),
    db
      .select({ id: schema.campaigns.id, name: schema.campaigns.name })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.workspaceId, ctx.workspaceId))
      .orderBy(desc(schema.campaigns.createdAt))
      .limit(50),
  ]);

  const total = countResult[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Fetch one preview asset per content item, plus per-content asset count.
  // Prefer a still image for the card thumbnail — only fall back to a video
  // if every variant for the post is a video.
  const contentIds = rows.map((r) => r.id);
  let assetByContent: Record<
    string,
    {
      previewPath: string | null;
      previewKind: string | null;
      previewMimeType: string | null;
      count: number;
    }
  > = {};
  if (contentIds.length > 0) {
    const assetRows = await db
      .select({
        contentId: schema.assets.contentId,
        storagePath: schema.assets.storagePath,
        kind: schema.assets.kind,
        mimeType: schema.assets.mimeType,
        createdAt: schema.assets.createdAt,
      })
      .from(schema.assets)
      .where(
        and(
          eq(schema.assets.workspaceId, ctx.workspaceId),
          isNotNull(schema.assets.contentId),
          inArray(schema.assets.contentId, contentIds),
        ),
      )
      .orderBy(desc(schema.assets.createdAt));

    assetByContent = assetRows.reduce<typeof assetByContent>((acc, a) => {
      const cid = a.contentId as string;
      const entry = acc[cid] ?? {
        previewPath: null,
        previewKind: null,
        previewMimeType: null,
        count: 0,
      };
      const isVideo = isVideoAsset(a);
      const havePreview = entry.previewPath !== null;
      const previewIsVideo = entry.previewPath
        ? isVideoAsset({ kind: entry.previewKind, mimeType: entry.previewMimeType })
        : false;
      // First asset wins, but a still image upgrades a video preview.
      if (!havePreview || (previewIsVideo && !isVideo)) {
        entry.previewPath = a.storagePath;
        entry.previewKind = a.kind;
        entry.previewMimeType = a.mimeType;
      }
      entry.count += 1;
      acc[cid] = entry;
      return acc;
    }, {});
  }

  const enriched = await Promise.all(
    rows.map(async (r) => {
      const a = assetByContent[r.id];
      const previewUrl = a?.previewPath
        ? await getSignedAssetUrl(a.previewPath).catch(() => null)
        : null;
      const { rationale, bodyCopy } = parseRationale(r.bodyMd ?? "");
      const previewText = (bodyCopy || rationale || r.bodyMd || "").trim();
      return {
        ...r,
        previewUrl,
        previewKind: a?.previewKind ?? null,
        previewMimeType: a?.previewMimeType ?? null,
        assetCount: a?.count ?? 0,
        previewText,
      };
    }),
  );

  const buildHref = (overrides: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { ...params, ...overrides };
    const qs = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join("&");
    return qs ? `?${qs}` : "?";
  };

  const filtersActive = !!(
    params.type ||
    params.status ||
    params.stage ||
    params.campaign ||
    params.has_image
  );

  return (
    <div>
      <PageHeader
        title="Posts"
        description="Every generated content item across campaigns — copy, image, status."
        meta={
          <>
            <Badge tone="neutral">
              {total} {total === 1 ? "post" : "posts"}
            </Badge>
            {filtersActive && <Badge tone="warn">filtered</Badge>}
          </>
        }
      />

      {/* Filters */}
      <div className="surface mb-5 px-3 py-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">Type</span>
        <FilterPill label="All" href={buildHref({ type: undefined, page: undefined })} active={!params.type} />
        {CONTENT_TYPES.map((t) => (
          <FilterPill
            key={t}
            label={t.replace("_", " ")}
            href={buildHref({ type: t, page: undefined })}
            active={params.type === t}
          />
        ))}

        <span className="h-5 w-px bg-[var(--border)] mx-1" />
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">Status</span>
        <FilterPill label="All" href={buildHref({ status: undefined, page: undefined })} active={!params.status} />
        {CONTENT_STATUSES.map((s) => (
          <FilterPill
            key={s}
            label={s.replace("_", " ")}
            href={buildHref({ status: s, page: undefined })}
            active={params.status === s}
          />
        ))}

        <span className="h-5 w-px bg-[var(--border)] mx-1" />
        <span className="text-[11px] uppercase tracking-wider text-faint pl-1 pr-1">Stage</span>
        <FilterPill label="All" href={buildHref({ stage: undefined, page: undefined })} active={!params.stage} />
        {CONTENT_STAGES.map((s) => (
          <FilterPill
            key={s}
            label={s}
            href={buildHref({ stage: s, page: undefined })}
            active={params.stage === s}
          />
        ))}

        <span className="h-5 w-px bg-[var(--border)] mx-1" />
        <FilterPill
          label="With image"
          href={buildHref({ has_image: params.has_image === "1" ? undefined : "1", page: undefined })}
          active={params.has_image === "1"}
        />

        {campaignOptions.length > 0 && (
          <>
            <span className="h-5 w-px bg-[var(--border)] mx-1" />
            <form action="" className="flex items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-faint">Campaign</span>
              <select
                name="campaign"
                defaultValue={params.campaign ?? ""}
                className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1 text-xs text-ink"
              >
                <option value="">All</option>
                {campaignOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {/* Preserve other filters when submitting */}
              {(["type", "status", "stage", "has_image"] as const).map((k) =>
                params[k] ? (
                  <input key={k} type="hidden" name={k} value={params[k]} />
                ) : null,
              )}
              <button type="submit" className="btn btn-secondary btn-sm">
                Apply
              </button>
            </form>
          </>
        )}

        {filtersActive && (
          <a href="?" className="btn btn-ghost btn-sm ml-auto">
            Reset
          </a>
        )}
      </div>

      {enriched.length === 0 ? (
        <EmptyState
          title="No posts yet"
          description="Generated content will appear here as soon as the content agent ships its first run."
          icon={
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 13h6M9 17h6" />
            </svg>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {enriched.map((p) => {
            const detailHref = `/campaigns/${p.campaignId}/content/${p.id}`;
            const date = new Date(p.publishedAt ?? p.createdAt);
            return (
              <article
                key={p.id}
                className="surface overflow-hidden flex flex-col group hover:border-[var(--border-strong)] transition-colors"
                style={{ padding: 0 }}
              >
                <Link
                  href={detailHref}
                  className="flex flex-col flex-1"
                  prefetch={false}
                >
                  <div className="flex gap-0">
                    {/* Image preview */}
                    <div className="w-40 shrink-0 aspect-square bg-[var(--surface-2)] relative overflow-hidden">
                      {p.previewUrl ? (
                        isVideoAsset({ kind: p.previewKind, mimeType: p.previewMimeType }) ? (
                          <video
                            src={p.previewUrl}
                            muted
                            playsInline
                            preload="metadata"
                            className="absolute inset-0 w-full h-full object-cover bg-black"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.previewUrl}
                            alt={p.title}
                            className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                          />
                        )
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-faint">
                          no image
                        </div>
                      )}
                      {p.assetCount > 1 && (
                        <span className="absolute bottom-2 right-2 badge bg-black/70 text-white border-transparent backdrop-blur-sm">
                          +{p.assetCount - 1} more
                        </span>
                      )}
                    </div>

                    {/* Body */}
                    <div className="flex-1 min-w-0 p-4 flex flex-col gap-2">
                      <div className="flex items-start gap-2 flex-wrap">
                        <Badge tone="neutral">{p.type.replace("_", " ")}</Badge>
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-mid">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              STAGE_DOT[p.stage] ?? "bg-zinc-400"
                            }`}
                          />
                          {p.stage}
                        </span>
                        <Badge tone={statusTone(p.status)} dot>
                          {p.status.replace("_", " ")}
                        </Badge>
                      </div>

                      <h3 className="text-[15px] font-semibold text-ink leading-snug line-clamp-2">
                        {p.title}
                      </h3>

                      {p.previewText && (
                        <p className="text-xs text-mid line-clamp-3 leading-snug">
                          {p.previewText}
                        </p>
                      )}

                      <div className="mt-auto pt-2 flex items-center justify-between text-[11px] text-faint">
                        <span className="truncate">
                          {p.campaignName ? (
                            <>📣 {p.campaignName}</>
                          ) : (
                            <span className="italic">No campaign</span>
                          )}
                        </span>
                        <span className="mono whitespace-nowrap shrink-0 ml-2">
                          {date.toLocaleDateString(undefined, {
                            month: "short",
                            day: "2-digit",
                            year: "numeric",
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                </Link>
              </article>
            );
          })}
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
              className={`btn btn-secondary btn-sm ${
                page <= 1 ? "pointer-events-none opacity-50" : ""
              }`}
            >
              ← Previous
            </a>
            <a
              href={buildHref({ page: String(Math.min(totalPages, page + 1)) })}
              className={`btn btn-secondary btn-sm ${
                page >= totalPages ? "pointer-events-none opacity-50" : ""
              }`}
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
        "px-2.5 py-1 text-[12px] rounded-md border transition-colors capitalize",
        active
          ? "bg-[var(--bg-elevated)] text-ink border-[var(--border-strong)] shadow-sm"
          : "bg-transparent text-mid border-transparent hover:text-ink hover:bg-[var(--surface-2)]",
      ].join(" ")}
    >
      {label}
    </a>
  );
}
