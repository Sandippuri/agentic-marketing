import type { Channel, PublishingAdapter, AdapterPublishResult } from "@marketing/shared-types";
import pino from "pino";
import { metaRequest } from "./meta-graph";

const log = pino({ name: "adapter:facebook" });

export type FacebookPayload = {
  contentId: string;
  title: string;
  bodyMd: string;
  /** Public image URL. If set, posts as a photo (richer preview). */
  assetSignedUrl?: string;
  /** Optional canonical link to attach to the post. */
  linkUrl?: string;
};

/**
 * Facebook Page feed adapter.
 * Requires: META_PAGE_ACCESS_TOKEN (long-lived page token), FB_PAGE_ID.
 */
export class FacebookAdapter implements PublishingAdapter<FacebookPayload> {
  readonly channel: Channel = "facebook";

  async publish(payload: FacebookPayload): Promise<AdapterPublishResult> {
    const pageId = process.env.FB_PAGE_ID;
    if (!pageId) throw new Error("FB_PAGE_ID must be set");

    log.info({ contentId: payload.contentId, hasAsset: !!payload.assetSignedUrl }, "facebook publish");

    let postId: string;
    if (payload.assetSignedUrl) {
      const r = await metaRequest<{ id: string; post_id: string }>(
        "POST",
        `/${pageId}/photos`,
        { url: payload.assetSignedUrl, caption: payload.bodyMd },
      );
      postId = r.post_id;
    } else {
      const r = await metaRequest<{ id: string }>(
        "POST",
        `/${pageId}/feed`,
        { message: payload.bodyMd, link: payload.linkUrl },
      );
      postId = r.id;
    }

    // Post id format is "{pageId}_{postId}" — the user-facing URL is built from that.
    const postUrl = `https://www.facebook.com/${postId.replace("_", "/posts/")}`;

    log.info({ postId, postUrl }, "facebook publish succeeded");
    return { externalId: postId, externalUrl: postUrl };
  }

  async retract(externalId: string): Promise<void> {
    log.info({ externalId }, "facebook retract");
    await metaRequest<{ success: boolean }>("DELETE", `/${externalId}`);
    log.info({ externalId }, "facebook retract succeeded");
  }

  async fetchMetrics(externalId: string): Promise<Record<string, number>> {
    try {
      const data = await metaRequest<{
        data?: Array<{ name: string; values: Array<{ value: number }> }>;
      }>("GET", `/${externalId}/insights`, {
        metric: "post_impressions,post_reactions_by_type_total,post_clicks,post_engaged_users",
      });
      const out: Record<string, number> = {};
      for (const m of data.data ?? []) {
        const v = m.values?.[0]?.value;
        if (typeof v === "number") out[m.name] = v;
      }
      return out;
    } catch (err) {
      log.warn({ err: (err as Error).message, externalId }, "facebook fetchMetrics failed");
      return {};
    }
  }
}
