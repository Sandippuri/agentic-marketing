// Builds a system-context snapshot for a campaign-scoped chat. Emitted as
// extra system text appended after ORCHESTRATOR_PROMPT so tool calls default
// to this campaign without the user restating it each turn.

import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";

const MAX_BRIEF_CHARS = 4000;
const MAX_ITEMS = 50;

export async function buildCampaignContext(campaignId: string): Promise<string | undefined> {
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return undefined;

  const items = await db
    .select({
      id: schema.contentItems.id,
      title: schema.contentItems.title,
      type: schema.contentItems.type,
      stage: schema.contentItems.stage,
      status: schema.contentItems.status,
      createdAt: schema.contentItems.createdAt,
    })
    .from(schema.contentItems)
    .where(eq(schema.contentItems.campaignId, campaignId))
    .orderBy(desc(schema.contentItems.createdAt))
    .limit(MAX_ITEMS);

  const brief = (campaign.briefMd ?? "").slice(0, MAX_BRIEF_CHARS);
  const itemsBlock = items.length === 0
    ? "(no content items drafted yet)"
    : items
        .map(
          (it) =>
            `- ${it.id}  [${it.status}]  ${it.type}/${it.stage}  "${it.title}"`,
        )
        .join("\n");

  return [
    "## Campaign scope",
    "",
    `This conversation is scoped to a single campaign. When you call any tool that takes a campaignId, default to this one unless the user explicitly references another campaign:`,
    "",
    `- campaignId: ${campaign.id}`,
    `- name: ${campaign.name}`,
    `- slug: ${campaign.slug}`,
    `- phase: ${campaign.phase}`,
    `- status: ${campaign.status}`,
    "",
    "### Brief (excerpt)",
    "",
    brief || "(no brief)",
    "",
    "### Content items in this campaign",
    "",
    itemsBlock,
    "",
    "When the user asks to edit a post, prefer the run_content sub-agent with the matching contentId from the list above. Do not act on content outside this campaign.",
  ].join("\n");
}
