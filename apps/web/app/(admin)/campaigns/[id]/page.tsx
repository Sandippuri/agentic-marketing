import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb, schema } from "@marketing/db";

export default async function CampaignDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, id))
    .limit(1);
  if (!campaign) notFound();

  const items = await db
    .select()
    .from(schema.contentItems)
    .where(eq(schema.contentItems.campaignId, id));

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{campaign.name}</h1>
        <p className="text-xs text-zinc-500 mt-1">
          {campaign.slug} · {campaign.phase} · {campaign.status}
        </p>
      </header>
      <h2 className="text-lg font-medium mb-3">Content items</h2>
      {items.length === 0 ? (
        <p className="text-zinc-500">No content items yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {items.map((it) => (
            <li key={it.id} className="py-3 flex items-baseline justify-between">
              <span>{it.title}</span>
              <span className="text-xs text-zinc-500">
                {it.type} · {it.stage} · {it.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
