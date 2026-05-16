import Link from "next/link";
import Image from "next/image";
import { and, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb, schema } from "@marketing/db";
import { parseRationale } from "@marketing/shared-types";
import { getSignedAssetUrl } from "@/lib/supabase/storage";
import { isVideoAsset } from "@/lib/asset-media";
import { getWorkspaceContext } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  in_review: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  published: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  retracted: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const STAGE_DOT: Record<string, string> = {
  pull: "bg-sky-500",
  explain: "bg-violet-500",
  reinforce: "bg-amber-500",
  push: "bg-emerald-500",
};

const APPROVAL_BADGE: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  changes_requested: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

export default async function ContentDetail({
  params,
}: {
  params: Promise<{ id: string; contentId: string }>;
}) {
  const { id, contentId } = await params;
  const db = getDb();
  const ctx = await getWorkspaceContext();

  const [item] = await db
    .select()
    .from(schema.contentItems)
    .where(
      and(
        eq(schema.contentItems.id, contentId),
        eq(schema.contentItems.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!item || item.campaignId !== id) notFound();

  const [campaign] = await db
    .select({ name: schema.campaigns.name })
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.id, id),
        eq(schema.campaigns.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);

  const [assetRows, revisions, approvalRows] = await Promise.all([
    db
      .select()
      .from(schema.assets)
      .where(
        and(
          eq(schema.assets.workspaceId, ctx.workspaceId),
          eq(schema.assets.contentId, contentId),
        ),
      )
      .orderBy(desc(schema.assets.createdAt)),
    db
      .select()
      .from(schema.contentRevisions)
      .where(
        and(
          eq(schema.contentRevisions.workspaceId, ctx.workspaceId),
          eq(schema.contentRevisions.contentId, contentId),
        ),
      )
      .orderBy(desc(schema.contentRevisions.createdAt)),
    db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.workspaceId, ctx.workspaceId),
          eq(schema.approvals.contentId, contentId),
        ),
      )
      .orderBy(desc(schema.approvals.requestedAt)),
  ]);

  const assets = await Promise.all(
    assetRows.map(async (a) => ({
      ...a,
      signedUrl: await getSignedAssetUrl(a.storagePath).catch(() => null),
    })),
  );

  const { rationale, bodyCopy } = parseRationale(item.bodyMd ?? "");

  const channelHints =
    item.channelHints && typeof item.channelHints === "object"
      ? (item.channelHints as Record<string, unknown>)
      : null;

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1 text-sm">
          <Link
            href={`/campaigns/${id}`}
            className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            ← {campaign?.name ?? "Campaign"}
          </Link>
        </div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          {item.title}
        </h1>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span className="text-xs text-zinc-500">{item.type}</span>
          <span className="text-xs text-zinc-400">·</span>
          <span className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${STAGE_DOT[item.stage] ?? "bg-zinc-400"}`}
            />
            {item.stage}
          </span>
          <span className="text-xs text-zinc-400">·</span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              STATUS_BADGE[item.status] ?? "bg-zinc-100 text-zinc-600"
            }`}
          >
            {item.status.replace("_", " ")}
          </span>
          <span className="text-xs text-zinc-400">·</span>
          <span className="text-xs text-zinc-500">
            Created {new Date(item.createdAt).toLocaleString()}
          </span>
        </div>
        {item.publishedUrl && (
          <a
            href={item.publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {item.publishedUrl} ↗
          </a>
        )}
      </div>

      {/* Assets */}
      {assets.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
            Assets ({assets.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {assets.map((asset) => (
              <div
                key={asset.id}
                className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden bg-zinc-50 dark:bg-zinc-900"
              >
                {asset.signedUrl ? (
                  <div className="relative aspect-square bg-zinc-100 dark:bg-zinc-800">
                    {isVideoAsset(asset) ? (
                      <video
                        src={asset.signedUrl}
                        controls
                        playsInline
                        preload="metadata"
                        className="absolute inset-0 h-full w-full object-cover bg-black"
                      >
                        <track kind="captions" />
                      </video>
                    ) : (
                      <Image
                        src={asset.signedUrl}
                        alt={asset.kind}
                        fill
                        sizes="(max-width: 640px) 100vw, 50vw"
                        className="object-cover"
                      />
                    )}
                  </div>
                ) : (
                  <div className="aspect-square flex items-center justify-center text-xs text-zinc-500">
                    Preview unavailable
                  </div>
                )}
                <div className="p-3 space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                      {asset.kind}
                    </span>
                    <span className="text-zinc-500">{asset.status}</span>
                  </div>
                  {asset.promptUsed && (
                    <p className="text-xs text-zinc-500 italic line-clamp-3">
                      {asset.promptUsed}
                    </p>
                  )}
                  {asset.signedUrl && (
                    <a
                      href={asset.signedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      Open full size ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* AI Rationale */}
      {rationale && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
            AI Rationale
          </h2>
          <div className="rounded-xl border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-900/20 p-4">
            <p className="text-sm text-zinc-700 dark:text-zinc-300 italic leading-relaxed whitespace-pre-wrap">
              {rationale}
            </p>
          </div>
        </section>
      )}

      {/* Body copy */}
      <section>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
          Body
        </h2>
        {bodyCopy ? (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
            <pre className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed font-sans">
              {bodyCopy}
            </pre>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No body content yet.</p>
        )}
      </section>

      {/* Channel hints */}
      {channelHints && Object.keys(channelHints).length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
            Channel Hints
          </h2>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
            <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed font-mono overflow-x-auto">
              {JSON.stringify(channelHints, null, 2)}
            </pre>
          </div>
        </section>
      )}

      {/* Schedule */}
      {(item.scheduledFor || item.publishedAt) && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
            Schedule
          </h2>
          <dl className="text-sm grid grid-cols-2 gap-x-4 gap-y-2">
            {item.scheduledFor && (
              <>
                <dt className="text-zinc-500">Scheduled for</dt>
                <dd className="text-zinc-700 dark:text-zinc-300">
                  {new Date(item.scheduledFor).toLocaleString()}
                </dd>
              </>
            )}
            {item.publishedAt && (
              <>
                <dt className="text-zinc-500">Published at</dt>
                <dd className="text-zinc-700 dark:text-zinc-300">
                  {new Date(item.publishedAt).toLocaleString()}
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

      {/* Approvals history */}
      {approvalRows.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
            Approval History ({approvalRows.length})
          </h2>
          <ul className="rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
            {approvalRows.map((a) => (
              <li key={a.id} className="px-4 py-2.5 text-sm flex items-center gap-3">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    a.decision
                      ? APPROVAL_BADGE[a.decision] ?? "bg-zinc-100 text-zinc-600"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                  }`}
                >
                  {a.decision ? a.decision.replace("_", " ") : "pending"}
                </span>
                <span className="text-xs text-zinc-500">
                  {a.decidedAt
                    ? `decided ${new Date(a.decidedAt).toLocaleString()}`
                    : `requested ${new Date(a.requestedAt).toLocaleString()}`}
                </span>
                {a.reason && (
                  <span className="text-xs text-zinc-600 dark:text-zinc-400 italic truncate">
                    “{a.reason}”
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Revisions */}
      {revisions.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">
            Revisions ({revisions.length})
          </h2>
          <ul className="rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
            {revisions.map((r) => (
              <li key={r.id} className="px-4 py-2.5 text-sm">
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {r.authorKind}
                  </span>
                  <span>·</span>
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                  {r.id === item.currentRevisionId && (
                    <span className="ml-auto text-xs px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 font-medium">
                      current
                    </span>
                  )}
                </div>
                {r.changeNote && (
                  <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400 italic">
                    {r.changeNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
