import type { Job, Queue } from "bullmq";
import type { CpClient } from "@marketing/cp-client";
import type { Channel, PublishingAdapter } from "@marketing/shared-types";
import type { MetricsFetchJobData } from "./metrics-cron";
import { scheduleMetricsFetch } from "./metrics-cron";

export type PublishJobData = {
  publishJobId: string;
  contentId: string;
  channel: Channel;
  threadRef?: string;
};

export async function runJob(
  job: Job<PublishJobData>,
  cp: CpClient,
  adapters: Partial<Record<Channel, PublishingAdapter>>,
  metricsQueue?: Queue<MetricsFetchJobData>,
) {
  const { publishJobId, channel } = job.data;

  // --- Kill-switch gate ---------------------------------------------------
  const settings = await cp.getSettings();
  if (settings.kill_switch) {
    await cp.patchPublishJob(publishJobId, {
      status: "cancelled",
      error: "kill_switch is active — publishing paused by operator",
    });
    return;
  }

  // --- Channel-cap gate ---------------------------------------------------
  const cap = settings.channel_caps?.[channel];
  if (cap !== undefined) {
    const todayCounts = await cp.getTodayChannelCounts();
    const todayCount = todayCounts[channel] ?? 0;
    if (todayCount >= cap) {
      await cp.patchPublishJob(publishJobId, {
        status: "failed",
        error: `channel cap reached: ${todayCount}/${cap} ${channel} posts today`,
      });
      return;
    }
  }

  // --- Adapter dispatch ---------------------------------------------------
  const adapter = adapters[channel];
  if (!adapter) {
    await cp.patchPublishJob(publishJobId, {
      status: "failed",
      error: `no adapter registered for channel ${channel}`,
    });
    return;
  }

  await cp.patchPublishJob(publishJobId, { status: "running" });
  try {
    const result = await adapter.publish(job.data);
    await cp.patchPublishJob(publishJobId, {
      status: "succeeded",
      externalId: result.externalId,
      externalUrl: result.externalUrl,
    });

    // Schedule a 24h-delayed metrics fetch for email channels.
    if (metricsQueue && (channel === "email_hubspot" || channel === "email_mailchimp")) {
      await scheduleMetricsFetch(metricsQueue, {
        publishJobId,
        contentId: job.data.contentId,
        channel,
        externalId: result.externalId,
      }).catch(() => null);
    }
    if (job.data.threadRef) {
      // Primary success notification.
      const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
      const fullUrl = result.externalUrl.startsWith("/")
        ? `${baseUrl}${result.externalUrl}`
        : result.externalUrl;

      const publishMsg = channel === "internal_blog"
        ? `✅ Published: ${fullUrl}`
        : `✅ Published to ${channel}: ${fullUrl}`;

      await cp
        .notifyThread({ threadRef: job.data.threadRef as never, message: publishMsg })
        .catch(() => null);

      // Phase 9 Day 1 — syndication card for internal_blog.
      // Post a "Copy for Medium" message with the canonical link so the
      // operator can one-click syndicate to Medium / Substack / Hashnode.
      if (channel === "internal_blog") {
        const canonicalUrl = fullUrl;
        const syndicationMsg = [
          `📋 *Syndication checklist* for \`${result.externalId}\`:`,
          `> Canonical URL (include in every cross-post): ${canonicalUrl}`,
          `> Medium: paste body, set canonical to ↑`,
          `> Substack: paste body, add "Originally published at" footer`,
          `> Hashnode: import from URL or paste with canonical`,
          `> Dev.to: use \`canonical_url\` in front matter`,
        ].join("\n");
        await cp
          .notifyThread({ threadRef: job.data.threadRef as never, message: syndicationMsg })
          .catch(() => null);
      }
    }
  } catch (err) {
    await cp.patchPublishJob(publishJobId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
