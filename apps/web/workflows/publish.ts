import { sleep, FatalError } from "workflow";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  maxImagesForChannel,
  type Channel,
  type SettingsShape,
} from "@marketing/shared-types";
import {
  InternalBlogAdapter,
  XAdapter,
  HubspotEmailAdapter,
  MailchimpAdapter,
  buildSocialAdapter,
} from "@marketing/agents/adapters";
import { CpClient } from "@marketing/cp-client";
import { loadSocialAdapterCreds } from "@/lib/oauth/channel-creds";
import { getSignedAssetUrl } from "@/lib/supabase/storage";

// Phase 2 of the Vercel migration. Mirror of apps/distributor/src/worker.ts
// without BullMQ. Used by:
//   - apps/web/lib/publish-queue.ts when WORKFLOW_PUBLISH=1
//   - apps/web/workflows/single-post.ts (replaces the publish stub)
// Keeps the existing logic shape: test-mode short-circuit → kill-switch →
// channel-cap → adapter → patch publish_jobs row → optional delayed metrics
// fan-out for email channels.

export type PublishWorkflowInput = {
  publishJobId: string;
  contentId: string;
  workspaceId: string;
  channel: Channel;
  threadRef?: string;
  mode?: "live" | "test";
  /** Optional delay before the adapter call. Used when scheduledAt > now. */
  delaySeconds?: number;
};

export type PublishWorkflowOutput = {
  status: "succeeded" | "failed" | "cancelled" | "skipped";
  externalId?: string;
  externalUrl?: string;
  error?: string;
};

// --- workflow ----------------------------------------------------------------

export async function publishWorkflow(
  input: PublishWorkflowInput,
): Promise<PublishWorkflowOutput> {
  "use workflow";

  if (input.delaySeconds && input.delaySeconds > 0) {
    await sleep(`${input.delaySeconds}s`);
  }

  if (input.mode === "test") {
    return testModePublish(input);
  }

  const gate = await runGatesStep(input);
  if (gate.blocked) {
    return {
      status: gate.status,
      ...(gate.error ? { error: gate.error } : {}),
    };
  }

  const result = await adapterPublishStep(input);
  await markSucceededStep({
    publishJobId: input.publishJobId,
    externalId: result.externalId,
    externalUrl: result.externalUrl,
  });

  if (input.threadRef) {
    await notifyThreadStep({
      threadRef: input.threadRef,
      channel: input.channel,
      externalId: result.externalId,
      externalUrl: result.externalUrl,
    });
  }

  // Email channels publish, then 24h later we fetch metrics. The metrics
  // workflow is scheduled with sleep("24h") at the top and runs as its own
  // durable run so this workflow can complete now.
  if (
    input.channel === "email_hubspot" ||
    input.channel === "email_mailchimp"
  ) {
    await scheduleMetricsFetchStep({
      publishJobId: input.publishJobId,
      contentId: input.contentId,
      workspaceId: input.workspaceId,
      channel: input.channel,
      externalId: result.externalId,
    });
  }

  return {
    status: "succeeded",
    externalId: result.externalId,
    externalUrl: result.externalUrl,
  };
}

// --- steps -------------------------------------------------------------------

async function testModePublish(
  input: PublishWorkflowInput,
): Promise<PublishWorkflowOutput> {
  "use step";
  const db = getDb();
  const externalId = `test-${input.publishJobId.slice(0, 8)}`;
  const externalUrl = `https://test.local/${input.channel}/${externalId}`;
  await db
    .update(schema.publishJobs)
    .set({
      status: "succeeded",
      externalId,
      externalUrl,
      updatedAt: new Date(),
    })
    .where(eq(schema.publishJobs.id, input.publishJobId));
  if (input.threadRef) {
    await notifyThread(
      input.threadRef,
      `🧪 [TEST] Skipped real publish to ${input.channel}. Pretend URL: ${externalUrl}`,
    );
  }
  return { status: "succeeded", externalId, externalUrl };
}

type GateResult =
  | { blocked: false }
  | { blocked: true; status: "cancelled" | "failed" | "skipped"; error: string };

async function runGatesStep(
  input: PublishWorkflowInput,
): Promise<GateResult> {
  "use step";
  const db = getDb();
  const settings = await loadSettings(db);

  if (settings.kill_switch) {
    await db
      .update(schema.publishJobs)
      .set({
        status: "cancelled",
        error: "kill_switch is active — publishing paused by operator",
        updatedAt: new Date(),
      })
      .where(eq(schema.publishJobs.id, input.publishJobId));
    return {
      blocked: true,
      status: "cancelled",
      error: "kill_switch active",
    };
  }

  const cap = settings.channel_caps?.[input.channel];
  if (cap !== undefined) {
    const todayCount = await todayChannelCount(db, input.channel);
    if (todayCount >= cap) {
      const error = `channel cap reached: ${todayCount}/${cap} ${input.channel} posts today`;
      await db
        .update(schema.publishJobs)
        .set({ status: "failed", error, updatedAt: new Date() })
        .where(eq(schema.publishJobs.id, input.publishJobId));
      return { blocked: true, status: "failed", error };
    }
  }

  await db
    .update(schema.publishJobs)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(schema.publishJobs.id, input.publishJobId));

  return { blocked: false };
}

async function adapterPublishStep(input: PublishWorkflowInput): Promise<{
  externalId: string;
  externalUrl: string;
}> {
  "use step";

  const adapter = await buildAdapterForChannel(input.workspaceId, input.channel);
  if (!adapter) {
    const error = `no adapter registered for channel ${input.channel}`;
    const db = getDb();
    await db
      .update(schema.publishJobs)
      .set({ status: "failed", error, updatedAt: new Date() })
      .where(eq(schema.publishJobs.id, input.publishJobId));
    // FatalError prevents workflow-level retries on a permanent config issue.
    throw new FatalError(error);
  }

  const payload = await loadAdapterPayload(input);

  try {
    const result = await adapter.publish(payload as never);
    return {
      externalId: result.externalId,
      externalUrl: result.externalUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const db = getDb();
    await db
      .update(schema.publishJobs)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(eq(schema.publishJobs.id, input.publishJobId));
    throw err;
  }
}

async function markSucceededStep(payload: {
  publishJobId: string;
  externalId: string;
  externalUrl: string;
}): Promise<void> {
  "use step";
  const db = getDb();
  await db
    .update(schema.publishJobs)
    .set({
      status: "succeeded",
      externalId: payload.externalId,
      externalUrl: payload.externalUrl,
      updatedAt: new Date(),
    })
    .where(eq(schema.publishJobs.id, payload.publishJobId));
  // Also mirror onto content_items for the public blog page.
  const [job] = await db
    .select({ contentId: schema.publishJobs.contentId })
    .from(schema.publishJobs)
    .where(eq(schema.publishJobs.id, payload.publishJobId))
    .limit(1);
  if (job?.contentId) {
    await db
      .update(schema.contentItems)
      .set({
        status: "published",
        publishedAt: new Date(),
        publishedUrl: payload.externalUrl,
        updatedAt: new Date(),
      })
      .where(eq(schema.contentItems.id, job.contentId));
  }
}

async function notifyThreadStep(payload: {
  threadRef: string;
  channel: Channel;
  externalId: string;
  externalUrl: string;
}): Promise<void> {
  "use step";
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const fullUrl = payload.externalUrl.startsWith("/")
    ? `${baseUrl}${payload.externalUrl}`
    : payload.externalUrl;
  const publishMsg =
    payload.channel === "internal_blog"
      ? `✅ Published: ${fullUrl}`
      : `✅ Published to ${payload.channel}: ${fullUrl}`;
  await notifyThread(payload.threadRef, publishMsg);
  if (payload.channel === "internal_blog") {
    const syndicationMsg = [
      `📋 *Syndication checklist* for \`${payload.externalId}\`:`,
      `> Canonical URL (include in every cross-post): ${fullUrl}`,
      `> Medium: paste body, set canonical to ↑`,
      `> Substack: paste body, add "Originally published at" footer`,
      `> Hashnode: import from URL or paste with canonical`,
      `> Dev.to: use \`canonical_url\` in front matter`,
    ].join("\n");
    await notifyThread(payload.threadRef, syndicationMsg);
  }
}

async function scheduleMetricsFetchStep(payload: {
  publishJobId: string;
  contentId: string;
  workspaceId: string;
  channel: Channel;
  externalId: string;
}): Promise<void> {
  "use step";
  // Lazy import to avoid a hard import cycle with workflows/metrics.ts.
  const { start } = await import("workflow/api");
  const { metricsFetchWorkflow } = await import("./metrics");
  await start(metricsFetchWorkflow, [payload]);
}

// --- helpers (run inside steps) ----------------------------------------------

async function loadSettings(
  db: ReturnType<typeof getDb>,
): Promise<Partial<SettingsShape>> {
  const rows = await db.select().from(schema.settings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<SettingsShape>;
}

async function todayChannelCount(
  db: ReturnType<typeof getDb>,
  channel: Channel,
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.publishJobs)
    .where(
      sql`${schema.publishJobs.channel} = ${channel} AND ${schema.publishJobs.createdAt} >= date_trunc('day', now())`,
    );
  return Number(result[0]?.count ?? 0);
}

async function loadAdapterPayload(input: PublishWorkflowInput): Promise<unknown> {
  const db = getDb();
  const [content] = await db
    .select()
    .from(schema.contentItems)
    .where(eq(schema.contentItems.id, input.contentId))
    .limit(1);
  if (!content) {
    throw new FatalError(`content_item ${input.contentId} not found`);
  }
  // InternalBlog needs only the contentId (its adapter pulls via cp-client).
  if (input.channel === "internal_blog") {
    return { contentId: input.contentId };
  }

  // Multi-image: load every APPROVED asset for this content, ordered by slot
  // (cover at 0, swipes after). Sign each URL in parallel. Cap the array at
  // the channel's native maximum so a 4-image post cross-published to
  // LinkedIn (single-image only) doesn't try to send extras the adapter
  // would silently drop. Signing failures fall through — adapter publishes
  // the slots it has and logs the gap.
  const approvedAssets = await db
    .select({
      storagePath: schema.assets.storagePath,
      mimeType: schema.assets.mimeType,
      sequenceOrder: schema.assets.sequenceOrder,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.contentId, input.contentId),
        eq(schema.assets.status, "approved"),
      ),
    )
    .orderBy(schema.assets.sequenceOrder);

  // Filter to images (video assets live in a separate publish path) and
  // dedupe within a slot — if a row exists per slot, keep the first.
  const bySlot = new Map<number, { storagePath: string }>();
  for (const a of approvedAssets) {
    const isImage = !a.mimeType || a.mimeType.startsWith("image/");
    if (!isImage) continue;
    const slot = a.sequenceOrder ?? 0;
    if (!bySlot.has(slot)) bySlot.set(slot, { storagePath: a.storagePath });
  }
  const orderedSlots = [...bySlot.entries()].sort(([a], [b]) => a - b);
  const cap = maxImagesForChannel(input.channel);
  const cappedSlots = orderedSlots.slice(0, cap);

  const signed = await Promise.all(
    cappedSlots.map(async ([, v]) => {
      try {
        return await getSignedAssetUrl(v.storagePath);
      } catch {
        return null;
      }
    }),
  );
  const assetSignedUrls = signed.filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  // Adapters still read assetSignedUrl when present — keep it pointing at
  // the lead (slot 0) so single-image adapters (LinkedIn, email) don't need
  // to know about the array form.
  const assetSignedUrl = assetSignedUrls[0];

  return {
    contentId: input.contentId,
    title: content.title,
    bodyMd: content.bodyMd,
    assetSignedUrl,
    assetSignedUrls,
  };
}

async function buildAdapterForChannel(workspaceId: string, channel: Channel) {
  // Internal_blog needs a CpClient pointed at our own API.
  if (channel === "internal_blog") {
    const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
    const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
    const cp = new CpClient({ baseUrl, internalToken });
    return new InternalBlogAdapter(cp);
  }
  // LinkedIn / Facebook / Instagram require per-workspace OAuth tokens.
  if (channel === "linkedin" || channel === "facebook" || channel === "instagram") {
    const spec = await loadSocialAdapterCreds(workspaceId, channel);
    return spec ? buildSocialAdapter(spec) : null;
  }
  // X still uses platform-level OAuth 1.0a creds (required for v1.1 media
  // upload). The OAuth 2.0 connect flow stores a per-workspace user token —
  // wiring that into v2 text-only posting is a follow-up.
  if (channel === "x") {
    if (process.env.X_ACCESS_TOKEN) return new XAdapter();
    return null;
  }
  if (channel === "email_hubspot") {
    if (process.env.HUBSPOT_ACCESS_TOKEN) return new HubspotEmailAdapter();
    return null;
  }
  if (channel === "email_mailchimp") {
    if (process.env.MAILCHIMP_API_KEY) return new MailchimpAdapter();
    return null;
  }
  return null;
}

async function notifyThread(threadRef: string, message: string): Promise<void> {
  // Reuses the existing /api/thread-notify route. Best-effort.
  const base = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const token = process.env.INTERNAL_API_TOKEN ?? "";
  try {
    await fetch(`${base}/api/thread-notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": token,
      },
      body: JSON.stringify({ threadRef, message }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Non-critical.
  }
}
