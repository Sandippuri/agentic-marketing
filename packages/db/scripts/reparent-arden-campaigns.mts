// One-off: move the three Arden University campaigns from Legacy →
// user2's workspace. They were created via the strategist before the
// x-workspace-id header was wired through cp-client, so they landed in
// Legacy and never appeared on user2's Campaigns page.
//
// Run with:
//   DATABASE_URL=... pnpm --filter @marketing/db exec tsx scripts/reparent-arden-campaigns.mts --apply
//
// Without --apply it's a dry run: prints what would be touched, no writes.

import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../src/index.ts";

const TARGET_WORKSPACE = "4e976667-c3e7-4eca-8e9f-fc7d600b4ee6"; // user2
const LEGACY_WORKSPACE = "00000000-0000-0000-0000-000000000001";
const CAMPAIGN_IDS = [
  "0003cfc8-f2a8-45d4-9c77-5f55821be550",
  "5b1b96da-0951-412b-b5e0-21a174e3b23e",
  "3cff9bd3-6e16-4141-9951-1030ac8b97eb",
];

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = getDb();

  // Sanity: target workspace exists.
  const [target] = await db
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, TARGET_WORKSPACE))
    .limit(1);
  if (!target) {
    console.error(`target workspace ${TARGET_WORKSPACE} not found`);
    process.exit(1);
  }
  console.log(`target: ${target.name} (${target.id})`);

  // Sanity: campaigns still in Legacy.
  const campaigns = await db
    .select({
      id: schema.campaigns.id,
      slug: schema.campaigns.slug,
      name: schema.campaigns.name,
      workspaceId: schema.campaigns.workspaceId,
    })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.id, CAMPAIGN_IDS));

  if (campaigns.length === 0) {
    console.log("no matching campaigns found — already moved?");
    return;
  }

  const alreadyMoved = campaigns.filter((c) => c.workspaceId === TARGET_WORKSPACE);
  const inLegacy = campaigns.filter((c) => c.workspaceId === LEGACY_WORKSPACE);
  const elsewhere = campaigns.filter(
    (c) => c.workspaceId !== LEGACY_WORKSPACE && c.workspaceId !== TARGET_WORKSPACE,
  );

  console.log(`already in target workspace: ${alreadyMoved.length}`);
  for (const c of alreadyMoved) console.log(`  - ${c.slug} (${c.id})`);
  console.log(`in Legacy → will move: ${inLegacy.length}`);
  for (const c of inLegacy) console.log(`  - ${c.slug} — "${c.name}"`);
  if (elsewhere.length > 0) {
    console.warn(`unexpected workspace (refusing to touch): ${elsewhere.length}`);
    for (const c of elsewhere) {
      console.warn(`  - ${c.slug} in ${c.workspaceId}`);
    }
  }

  if (inLegacy.length === 0) {
    console.log("nothing to do.");
    return;
  }

  const idsToMove = inLegacy.map((c) => c.id);

  // Check slug collisions in the target workspace before moving.
  const targetSlugs = inLegacy.map((c) => c.slug);
  const collisions = await db
    .select({
      id: schema.campaigns.id,
      slug: schema.campaigns.slug,
    })
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.workspaceId, TARGET_WORKSPACE),
        inArray(schema.campaigns.slug, targetSlugs),
      ),
    );
  // user2 may already have a campaign on the same slug (e.g. the user
  // re-ran the strategist after the fix). For those, suffix the legacy
  // copy with `-legacy` so both can coexist.
  const slugRename = new Map<string, string>();
  const collidingSlugs = new Set(collisions.map((c) => c.slug));
  for (const c of inLegacy) {
    if (collidingSlugs.has(c.slug)) {
      slugRename.set(c.id, `${c.slug}-legacy`);
    }
  }
  if (slugRename.size > 0) {
    console.log("slug collisions — legacy copy will be suffixed `-legacy`:");
    for (const [id, slug] of slugRename) {
      console.log(`  - ${id} → ${slug}`);
    }
  }

  // Count descendants we'll also reparent, so the dry-run output is honest.
  const counts = await Promise.all([
    db
      .select()
      .from(schema.contentItems)
      .where(inArray(schema.contentItems.campaignId, idsToMove))
      .then((r) => r.length),
    db
      .select()
      .from(schema.workflowRuns)
      .where(inArray(schema.workflowRuns.campaignId, idsToMove))
      .then((r) => r.length),
    db
      .select()
      .from(schema.generationJobs)
      .where(inArray(schema.generationJobs.campaignId, idsToMove))
      .then((r) => r.length),
    db
      .select()
      .from(schema.brandMemory)
      .where(inArray(schema.brandMemory.campaignId, idsToMove))
      .then((r) => r.length),
    db
      .select()
      .from(schema.brandDesignSystem)
      .where(inArray(schema.brandDesignSystem.campaignId, idsToMove))
      .then((r) => r.length),
    db
      .select()
      .from(schema.kbCollections)
      .where(inArray(schema.kbCollections.campaignId, idsToMove))
      .then((r) => r.length),
    db
      .select()
      .from(schema.goalEvents)
      .where(inArray(schema.goalEvents.campaignId, idsToMove))
      .then((r) => r.length),
    db
      .select()
      .from(schema.experiments)
      .where(inArray(schema.experiments.campaignId, idsToMove))
      .then((r) => r.length),
    db
      .select()
      .from(schema.lifecycleSequences)
      .where(inArray(schema.lifecycleSequences.campaignId, idsToMove))
      .then((r) => r.length),
  ]);
  const [
    contentItemsCount,
    workflowRunsCount,
    generationJobsCount,
    brandMemoryCount,
    brandDesignSystemCount,
    kbCollectionsCount,
    goalEventsCount,
    experimentsCount,
    lifecycleSequencesCount,
  ] = counts;

  console.log("descendants to reparent:");
  console.log(`  content_items:        ${contentItemsCount}`);
  console.log(`  workflow_runs:        ${workflowRunsCount}`);
  console.log(`  generation_jobs:      ${generationJobsCount}`);
  console.log(`  brand_memory:         ${brandMemoryCount}`);
  console.log(`  brand_design_system:  ${brandDesignSystemCount}`);
  console.log(`  kb_collections:       ${kbCollectionsCount}`);
  console.log(`  goal_events:          ${goalEventsCount}`);
  console.log(`  experiments:          ${experimentsCount}`);
  console.log(`  lifecycle_sequences:  ${lifecycleSequencesCount}`);

  if (!APPLY) {
    console.log("\ndry run — pass --apply to actually move.");
    return;
  }

  // Single transaction so we either move everything or nothing. The
  // descendants list above is generated from schema.ts so adding new
  // campaign-scoped tables later just needs another update() here.
  await db.transaction(async (tx) => {
    const filter = (table: { campaignId: typeof schema.campaigns.id }) =>
      inArray(table.campaignId, idsToMove);

    await tx
      .update(schema.contentItems)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.contentItems));
    await tx
      .update(schema.workflowRuns)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.workflowRuns));
    await tx
      .update(schema.generationJobs)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.generationJobs));
    await tx
      .update(schema.brandMemory)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.brandMemory));
    await tx
      .update(schema.brandDesignSystem)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.brandDesignSystem));
    await tx
      .update(schema.kbCollections)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.kbCollections));
    await tx
      .update(schema.goalEvents)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.goalEvents));
    await tx
      .update(schema.experiments)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.experiments));
    await tx
      .update(schema.lifecycleSequences)
      .set({ workspaceId: TARGET_WORKSPACE })
      .where(filter(schema.lifecycleSequences));

    // Finally, the campaigns themselves. Rename the slug per row when a
    // collision was detected; otherwise just flip the workspace.
    for (const id of idsToMove) {
      const newSlug = slugRename.get(id);
      await tx
        .update(schema.campaigns)
        .set({
          workspaceId: TARGET_WORKSPACE,
          updatedAt: new Date(),
          ...(newSlug ? { slug: newSlug } : {}),
        })
        .where(eq(schema.campaigns.id, id));
    }
  });

  console.log("\nmoved.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
