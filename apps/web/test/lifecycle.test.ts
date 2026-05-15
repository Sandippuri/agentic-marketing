import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@marketing/db";
import { LEGACY_WORKSPACE_ID } from "@/lib/billing";

// Phase 1 Day 7 — full content lifecycle against the live Supabase database.
// Each test creates uniquely-slugged campaigns and cleans up everything it
// touched in afterAll. We don't wrap in a transaction because the API routes
// are not in scope here; we exercise Drizzle directly to validate the schema,
// state machine wiring, and the publish-gate trigger as one system.

const databaseUrl = process.env.DATABASE_URL;
const db = databaseUrl ? createDb(databaseUrl) : null;

const runId = `it-${Date.now().toString(36)}`;
const WS_ID = LEGACY_WORKSPACE_ID;

describe.skipIf(!db)("content lifecycle (live DB)", () => {
  const campaignIds: string[] = [];

  afterAll(async () => {
    if (!db || campaignIds.length === 0) return;
    // FKs cascade from campaigns -> content_items -> {revisions, approvals,
    // publish_jobs}. We also wipe the audit_log rows the test created so the
    // table doesn't accumulate noise across runs.
    await db
      .delete(schema.auditLog)
      .where(
        and(
          inArray(
            schema.auditLog.action,
            [
              "campaign.create",
              "content.create",
              "content.submit",
              "approval.approved",
              "approval.changes_requested",
              "publish_job.create",
            ],
          ),
        ),
      );
    await db
      .delete(schema.campaigns)
      .where(inArray(schema.campaigns.id, campaignIds));
  });

  it("draft -> in_review -> approved -> publish-gate accepts", async () => {
    if (!db) return;
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ workspaceId: WS_ID, slug: `${runId}-happy`, name: "Happy path" })
      .returning();
    campaignIds.push(campaign!.id);

    const [content] = await db
      .insert(schema.contentItems)
      .values({
        workspaceId: WS_ID,
        campaignId: campaign!.id,
        type: "blog",
        title: "Happy",
        bodyMd: "first",
      })
      .returning();
    expect(content!.status).toBe("draft");

    await db
      .update(schema.contentItems)
      .set({ status: "in_review" })
      .where(eq(schema.contentItems.id, content!.id));

    await db
      .update(schema.contentItems)
      .set({ status: "approved" })
      .where(eq(schema.contentItems.id, content!.id));

    const [job] = await db
      .insert(schema.publishJobs)
      .values({ workspaceId: WS_ID, contentId: content!.id, channel: "internal_blog" })
      .returning();
    expect(job!.status).toBe("queued");
    expect(job!.contentId).toBe(content!.id);
  });

  it("publish-gate rejects insert for draft content", async () => {
    if (!db) return;
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ workspaceId: WS_ID, slug: `${runId}-gate`, name: "Gate probe" })
      .returning();
    campaignIds.push(campaign!.id);

    const [content] = await db
      .insert(schema.contentItems)
      .values({
        workspaceId: WS_ID,
        campaignId: campaign!.id,
        type: "blog",
        title: "Gate",
        bodyMd: "",
      })
      .returning();

    await expect(
      db
        .insert(schema.publishJobs)
        .values({ workspaceId: WS_ID, contentId: content!.id, channel: "internal_blog" }),
    ).rejects.toThrow(/must be approved/);
  });

  it("24h same-channel republish guard rejects a duplicate", async () => {
    if (!db) return;
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ workspaceId: WS_ID, slug: `${runId}-dup`, name: "Dedup probe" })
      .returning();
    campaignIds.push(campaign!.id);

    const [content] = await db
      .insert(schema.contentItems)
      .values({
        workspaceId: WS_ID,
        campaignId: campaign!.id,
        type: "blog",
        title: "Dedup",
        bodyMd: "",
        status: "approved",
      })
      .returning();

    await db
      .insert(schema.publishJobs)
      .values({ workspaceId: WS_ID, contentId: content!.id, channel: "internal_blog" });

    await expect(
      db
        .insert(schema.publishJobs)
        .values({ workspaceId: WS_ID, contentId: content!.id, channel: "internal_blog" }),
    ).rejects.toThrow(/within last 24h/);
  });
});
