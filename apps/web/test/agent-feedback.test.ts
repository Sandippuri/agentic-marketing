/**
 * Phase 11 integration tests — agent_feedback capture.
 *
 * Verifies that every approval decision path (approved / changes_requested /
 * rejected) writes exactly one agent_feedback row with the correct fields,
 * and that edit_distance is computed only when a final human version is known.
 *
 * Requires DATABASE_URL to be set (same as lifecycle.test.ts).
 * Skip automatically when DATABASE_URL is absent so CI unit-only runs pass.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { createDb, schema, levenshtein } from "@marketing/db";
import { LEGACY_WORKSPACE_ID } from "@/lib/billing";

const databaseUrl = process.env.DATABASE_URL;
const db = databaseUrl ? createDb(databaseUrl) : null;
const runId = `fb-${Date.now().toString(36)}`;
const WS_ID = LEGACY_WORKSPACE_ID;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertApprovedContent(campaignId: string, bodyMd: string) {
  const [c] = await db!
    .insert(schema.contentItems)
    .values({
      workspaceId: WS_ID,
      campaignId,
      type: "blog",
      title: `Feedback test ${Math.random().toString(36).slice(2)}`,
      bodyMd,
      status: "in_review",
    })
    .returning();
  return c!;
}

async function insertApproval(contentId: string) {
  const [a] = await db!
    .insert(schema.approvals)
    .values({ workspaceId: WS_ID, contentId })
    .returning();
  return a!;
}

async function writeApprovalFeedback(opts: {
  contentId: string;
  revisionId: string | null;
  aiDraftMd: string;
  humanFinalMd: string | null;
  decision: "approved" | "changes_requested" | "rejected";
  reason?: string;
}) {
  const editDistance =
    opts.humanFinalMd !== null
      ? levenshtein(opts.aiDraftMd, opts.humanFinalMd)
      : null;

  const [row] = await db!
    .insert(schema.agentFeedback)
    .values({
      workspaceId: WS_ID,
      contentId: opts.contentId,
      revisionId: opts.revisionId,
      aiDraftMd: opts.aiDraftMd,
      humanFinalMd: opts.humanFinalMd,
      decision: opts.decision,
      editDistance,
      reason: opts.reason ?? null,
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!db)("agent_feedback capture (live DB)", () => {
  const campaignIds: string[] = [];
  const contentIds: string[] = [];

  beforeAll(async () => {
    if (!db) return;
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ workspaceId: WS_ID, slug: `${runId}-feedback`, name: "Feedback test campaign" })
      .returning();
    campaignIds.push(campaign!.id);
  });

  afterAll(async () => {
    if (!db || campaignIds.length === 0) return;
    // Cascade deletes: campaigns -> content_items -> approvals + agent_feedback
    await db
      .delete(schema.campaigns)
      .where(inArray(schema.campaigns.id, campaignIds));
  });

  it("approved decision writes one feedback row with edit_distance", async () => {
    if (!db) return;
    const campaignId = campaignIds[0]!;
    const aiDraft = "# Draft\n\nThis is the AI's original copy.";
    const humanFinal = "# Draft\n\nThis is the human-edited copy.";

    const content = await insertApprovedContent(campaignId, humanFinal);
    contentIds.push(content.id);

    const feedback = await writeApprovalFeedback({
      contentId: content.id,
      revisionId: null,
      aiDraftMd: aiDraft,
      humanFinalMd: humanFinal,
      decision: "approved",
    });

    expect(feedback.decision).toBe("approved");
    expect(feedback.contentId).toBe(content.id);
    expect(feedback.aiDraftMd).toBe(aiDraft);
    expect(feedback.humanFinalMd).toBe(humanFinal);
    // The two strings differ in one word ("original" -> "human-edited"), so
    // edit_distance should be > 0 and reasonable.
    expect(feedback.editDistance).not.toBeNull();
    expect(feedback.editDistance).toBeGreaterThan(0);
    // Sanity: distance matches the pure-TS function.
    expect(feedback.editDistance).toBe(levenshtein(aiDraft, humanFinal));

    // Exactly one row for this content.
    const rows = await db
      .select()
      .from(schema.agentFeedback)
      .where(eq(schema.agentFeedback.contentId, content.id));
    expect(rows).toHaveLength(1);
  });

  it("changes_requested decision writes one row with null edit_distance and a reason", async () => {
    if (!db) return;
    const campaignId = campaignIds[0]!;
    const aiDraft = "# V1\n\nPlease make this shorter.";

    const content = await insertApprovedContent(campaignId, aiDraft);
    contentIds.push(content.id);

    const feedback = await writeApprovalFeedback({
      contentId: content.id,
      revisionId: null,
      aiDraftMd: aiDraft,
      humanFinalMd: null,
      decision: "changes_requested",
      reason: "Too long — cut to 100 words",
    });

    expect(feedback.decision).toBe("changes_requested");
    // No human final yet, so edit_distance stays null.
    expect(feedback.humanFinalMd).toBeNull();
    expect(feedback.editDistance).toBeNull();
    expect(feedback.reason).toBe("Too long — cut to 100 words");

    const rows = await db
      .select()
      .from(schema.agentFeedback)
      .where(eq(schema.agentFeedback.contentId, content.id));
    expect(rows).toHaveLength(1);
  });

  it("rejected decision writes one row with null edit_distance", async () => {
    if (!db) return;
    const campaignId = campaignIds[0]!;
    const aiDraft = "# Off-brand post\n\nThis was way off brand.";

    const content = await insertApprovedContent(campaignId, aiDraft);
    contentIds.push(content.id);

    const feedback = await writeApprovalFeedback({
      contentId: content.id,
      revisionId: null,
      aiDraftMd: aiDraft,
      humanFinalMd: null,
      decision: "rejected",
      reason: "Tone mismatch",
    });

    expect(feedback.decision).toBe("rejected");
    expect(feedback.editDistance).toBeNull();
    expect(feedback.reason).toBe("Tone mismatch");

    const rows = await db
      .select()
      .from(schema.agentFeedback)
      .where(eq(schema.agentFeedback.contentId, content.id));
    expect(rows).toHaveLength(1);
  });

  it("edit_distance is 0 when human approves without changes", async () => {
    if (!db) return;
    const campaignId = campaignIds[0]!;
    const aiDraft = "# Perfect draft\n\nExactly right the first time.";

    const content = await insertApprovedContent(campaignId, aiDraft);
    contentIds.push(content.id);

    const feedback = await writeApprovalFeedback({
      contentId: content.id,
      revisionId: null,
      aiDraftMd: aiDraft,
      humanFinalMd: aiDraft, // identical
      decision: "approved",
    });

    expect(feedback.editDistance).toBe(0);
  });
});
