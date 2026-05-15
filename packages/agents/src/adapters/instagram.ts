import type { Channel, PublishingAdapter, AdapterPublishResult } from "@marketing/shared-types";
import pino from "pino";
import { metaRequest } from "./meta-graph";

const log = pino({ name: "adapter:instagram" });

export type InstagramPayload = {
  contentId: string;
  /** Caption text. Markdown is not rendered — bodyMd is used as-is. */
  bodyMd: string;
  /** Publicly reachable image URL. IG does not accept binary upload — must be a URL. */
  assetSignedUrl?: string;
  /** Optional public video URL for Reels. If both image + video set, video wins. */
  videoUrl?: string;
};

/**
 * Instagram Business (Graph API) adapter.
 * Two-step publish: create media container, then publish it.
 * Requires: META_PAGE_ACCESS_TOKEN, IG_BUSINESS_ACCOUNT_ID.
 * IG account must be a Business or Creator account linked to a Facebook Page.
 */
export class InstagramAdapter implements PublishingAdapter<InstagramPayload> {
  readonly channel: Channel = "instagram";

  async publish(payload: InstagramPayload): Promise<AdapterPublishResult> {
    const igUserId = process.env.IG_BUSINESS_ACCOUNT_ID;
    if (!igUserId) throw new Error("IG_BUSINESS_ACCOUNT_ID must be set");

    if (!payload.assetSignedUrl && !payload.videoUrl) {
      throw new Error("instagram publish requires assetSignedUrl or videoUrl — IG has no text-only post type");
    }

    log.info({ contentId: payload.contentId, hasVideo: !!payload.videoUrl }, "instagram publish");

    const containerParams: Record<string, string> = { caption: payload.bodyMd };
    if (payload.videoUrl) {
      containerParams.media_type = "REELS";
      containerParams.video_url = payload.videoUrl;
    } else if (payload.assetSignedUrl) {
      containerParams.image_url = payload.assetSignedUrl;
    }

    const container = await metaRequest<{ id: string }>(
      "POST",
      `/${igUserId}/media`,
      containerParams,
    );

    // Reels containers need a few seconds to process before publish accepts them.
    if (payload.videoUrl) {
      await waitForContainerReady(container.id);
    }

    const published = await metaRequest<{ id: string }>(
      "POST",
      `/${igUserId}/media_publish`,
      { creation_id: container.id },
    );

    const meta = await metaRequest<{ permalink: string }>(
      "GET",
      `/${published.id}`,
      { fields: "permalink" },
    );

    log.info({ mediaId: published.id, permalink: meta.permalink }, "instagram publish succeeded");
    return { externalId: published.id, externalUrl: meta.permalink };
  }

  // IG Graph API does not support deleting feed posts programmatically. Stories
  // are deletable, feed posts are not. Surface this clearly rather than silently
  // marking the content "retracted" in our DB while it remains live on IG.
  async retract(externalId: string): Promise<void> {
    log.warn({ externalId }, "instagram retract not supported by Graph API — manual deletion required");
    throw new Error(
      "Instagram feed posts cannot be deleted via Graph API. Delete manually in the IG app and call this adapter again to mark retracted.",
    );
  }

  async fetchMetrics(externalId: string): Promise<Record<string, number>> {
    try {
      const data = await metaRequest<{
        data?: Array<{ name: string; values: Array<{ value: number }> }>;
      }>("GET", `/${externalId}/insights`, {
        metric: "impressions,reach,likes,comments,saved,shares",
      });
      const out: Record<string, number> = {};
      for (const m of data.data ?? []) {
        out[m.name] = m.values?.[0]?.value ?? 0;
      }
      return out;
    } catch (err) {
      log.warn({ err: (err as Error).message, externalId }, "instagram fetchMetrics failed");
      return {};
    }
  }
}

// Poll the container status until FINISHED, or fail after ~30s.
async function waitForContainerReady(containerId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { status_code } = await metaRequest<{ status_code: string }>(
      "GET",
      `/${containerId}`,
      { fields: "status_code" },
    );
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`instagram media container ${containerId} failed: ${status_code}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`instagram media container ${containerId} not ready within 30s`);
}
