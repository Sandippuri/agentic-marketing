import { desc } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import Link from "next/link";
import { NewCampaignForm } from "./new-campaign-form";

export const dynamic = "force-dynamic";

// Server Component: read campaigns directly via Drizzle (no API roundtrip)
// for the initial render. The TanStack Query cache is seeded by the form's
// invalidate-on-success.
export default async function CampaignsPage() {
  const db = getDb();
  const campaigns = await db
    .select()
    .from(schema.campaigns)
    .orderBy(desc(schema.campaigns.createdAt));

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Campaigns</h1>
      <NewCampaignForm />
      {campaigns.length === 0 ? (
        <p className="text-zinc-500">
          No campaigns yet. Create one above or via @marketing in Slack.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {campaigns.map((c) => (
            <li key={c.id} className="py-3 flex items-baseline justify-between">
              <Link
                href={`/campaigns/${c.id}`}
                className="font-medium hover:underline"
              >
                {c.name}
              </Link>
              <span className="text-xs text-zinc-500">
                {c.phase} · {c.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
