import type { Channel, PublishingAdapter, AdapterPublishResult } from "@marketing/shared-types";
import pino from "pino";
import { metaRequest } from "./meta-graph";

const log = pino({ name: "adapter:facebook" });

export type FacebookPayload = {
  contentId: string;
  title: string;
  bodyMd: string;
  /**
   * Single-image URL — used when assetSignedUrls is absent or has one entry.
   * Posts via /photos as a single-photo post (richer preview than /feed).
   */
  assetSignedUrl?: string;
  /**
   * Multi-image URLs. When >1, the adapter uploads each as an unpublished
   * photo and attaches them via `attached_media[i]` to a single /feed post,
   * producing a native FB album with the message as the caption.
   */
  assetSignedUrls?: string[];
  /** Optional canonical link to attach to the post. */
  linkUrl?: string;
};

export type FacebookCreds = {
  pageAccessToken: string;
  pageId: string;
};

/**
 * Facebook Page feed adapter.
 * Posts via the long-lived Page Access Token returned by /me/accounts.
 */
export class FacebookAdapter implements PublishingAdapter<FacebookPayload> {
  readonly channel: Channel = "facebook";
  private readonly token: string;
  private readonly pageId: string;

  constructor(creds: FacebookCreds) {
    this.token = creds.pageAccessToken;
    this.pageId = creds.pageId;
  }

  async publish(payload: FacebookPayload): Promise<AdapterPublishResult> {
    const { token, pageId } = this;

    const urls =
      payload.assetSignedUrls && payload.assetSignedUrls.length > 0
        ? payload.assetSignedUrls
        : payload.assetSignedUrl
          ? [payload.assetSignedUrl]
          : [];

    log.info(
      { contentId: payload.contentId, imageCount: urls.length },
      "facebook publish",
    );

    let postId: string;
    if (urls.length >= 2) {
      // Album path: upload each photo as `published=false` to grab its id,
      // then attach via attached_media[i] to a single feed post. This is FB's
      // documented way to make a multi-image post show up as a native album
      // instead of N separate posts.
      const photoIds = await Promise.all(
        urls.map(async (url) => {
          const r = await metaRequest<{ id: string }>(
            token,
            "POST",
            `/${pageId}/photos`,
            { url, published: "false" },
          );
          return r.id;
        }),
      );
      const attachedMedia: Record<string, string> = {};
      photoIds.forEach((mid, i) => {
        attachedMedia[`attached_media[${i}]`] = JSON.stringify({ media_fbid: mid });
      });
      const r = await metaRequest<{ id: string }>(token, "POST", `/${pageId}/feed`, {
        message: payload.bodyMd,
        ...(payload.linkUrl ? { link: payload.linkUrl } : {}),
        ...attachedMedia,
      });
      postId = r.id;
    } else if (urls.length === 1) {
      const r = await metaRequest<{ id: string; post_id: string }>(
        token,
        "POST",
        `/${pageId}/photos`,
        { url: urls[0]!, caption: payload.bodyMd },
      );
      postId = r.post_id;
    } else {
      const r = await metaRequest<{ id: string }>(
        token,
        "POST",
        `/${pageId}/feed`,
        { message: payload.bodyMd, link: payload.linkUrl },
      );
      postId = r.id;
    }

    const postUrl = `https://www.facebook.com/${postId.replace("_", "/posts/")}`;
    log.info({ postId, postUrl }, "facebook publish succeeded");
    return { externalId: postId, externalUrl: postUrl };
  }

  async retract(externalId: string): Promise<void> {
    log.info({ externalId }, "facebook retract");
    await metaRequest<{ success: boolean }>(this.token, "DELETE", `/${externalId}`);
    log.info({ externalId }, "facebook retract succeeded");
  }

  async fetchMetrics(externalId: string): Promise<Record<string, number>> {
    try {
      const data = await metaRequest<{
        data?: Array<{ name: string; values: Array<{ value: number }> }>;
      }>(this.token, "GET", `/${externalId}/insights`, {
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
