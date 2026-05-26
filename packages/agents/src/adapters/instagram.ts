import type { Channel, PublishingAdapter, AdapterPublishResult } from "@marketing/shared-types";
import pino from "pino";
import { metaRequest } from "./meta-graph";

const log = pino({ name: "adapter:instagram" });

export type InstagramPayload = {
  contentId: string;
  /** Caption text. Markdown is not rendered — bodyMd is used as-is. */
  bodyMd: string;
  /**
   * Single-image URL — legacy / single-image posts and Reels' video posters.
   * When `assetSignedUrls` is set with >1 entries, this is ignored in favor
   * of the carousel path.
   */
  assetSignedUrl?: string;
  /**
   * Multi-image URLs (1–10 per Graph; we cap at 4 elsewhere). When >1, the
   * adapter publishes a CAROUSEL_ALBUM container holding one child per URL.
   * Single-element arrays use the single-image path identically to
   * `assetSignedUrl`.
   */
  assetSignedUrls?: string[];
  /** Optional public video URL for Reels. If both image + video set, video wins. */
  videoUrl?: string;
};

export type InstagramCreds = {
  /** Page Access Token from /me/accounts (IG inherits perms via the linked Page). */
  pageAccessToken: string;
  /** IG Business account id resolved via instagram_business_account on the Page. */
  igBusinessAccountId: string;
};

/**
 * Instagram Business (Graph API) adapter.
 * Two-step publish: create media container, then publish it.
 * IG account must be a Business or Creator account linked to a Facebook Page.
 */
export class InstagramAdapter implements PublishingAdapter<InstagramPayload> {
  readonly channel: Channel = "instagram";
  private readonly token: string;
  private readonly igUserId: string;

  constructor(creds: InstagramCreds) {
    this.token = creds.pageAccessToken;
    this.igUserId = creds.igBusinessAccountId;
  }

  async publish(payload: InstagramPayload): Promise<AdapterPublishResult> {
    const { token, igUserId } = this;

    // Normalize the URL inputs. assetSignedUrls (array) is the canonical
    // shape post-migration 0040; assetSignedUrl (singular) is the legacy
    // single-image field still emitted for backwards-compat. If both arrive
    // we trust the array.
    const urls =
      payload.assetSignedUrls && payload.assetSignedUrls.length > 0
        ? payload.assetSignedUrls
        : payload.assetSignedUrl
          ? [payload.assetSignedUrl]
          : [];

    if (urls.length === 0 && !payload.videoUrl) {
      throw new Error("instagram publish requires an image URL or videoUrl — IG has no text-only post type");
    }

    log.info(
      { contentId: payload.contentId, hasVideo: !!payload.videoUrl, imageCount: urls.length },
      "instagram publish",
    );

    let containerId: string;
    if (payload.videoUrl) {
      // Reels — single video, no carousel support.
      const container = await metaRequest<{ id: string }>(token, "POST", `/${igUserId}/media`, {
        caption: payload.bodyMd,
        media_type: "REELS",
        video_url: payload.videoUrl,
      });
      await waitForContainerReady(token, container.id);
      containerId = container.id;
    } else if (urls.length === 1) {
      // Single-image post (existing path).
      const container = await metaRequest<{ id: string }>(token, "POST", `/${igUserId}/media`, {
        caption: payload.bodyMd,
        image_url: urls[0]!,
      });
      containerId = container.id;
    } else {
      // Carousel: create one IS_CAROUSEL_ITEM child per URL (no caption on
      // children, caption goes on the parent), then a CAROUSEL_ALBUM parent
      // referencing them.
      const childIds = await Promise.all(
        urls.map(async (url) => {
          const child = await metaRequest<{ id: string }>(
            token,
            "POST",
            `/${igUserId}/media`,
            {
              image_url: url,
              is_carousel_item: "true",
            },
          );
          return child.id;
        }),
      );
      const parent = await metaRequest<{ id: string }>(token, "POST", `/${igUserId}/media`, {
        caption: payload.bodyMd,
        media_type: "CAROUSEL",
        children: childIds.join(","),
      });
      containerId = parent.id;
    }

    const published = await metaRequest<{ id: string }>(
      token,
      "POST",
      `/${igUserId}/media_publish`,
      { creation_id: containerId },
    );

    const meta = await metaRequest<{ permalink: string }>(
      token,
      "GET",
      `/${published.id}`,
      { fields: "permalink" },
    );

    log.info({ mediaId: published.id, permalink: meta.permalink }, "instagram publish succeeded");
    return { externalId: published.id, externalUrl: meta.permalink };
  }

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
      }>(this.token, "GET", `/${externalId}/insights`, {
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

async function waitForContainerReady(token: string, containerId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { status_code } = await metaRequest<{ status_code: string }>(
      token,
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
