import type { Channel, PublishingAdapter, AdapterPublishResult } from "@marketing/shared-types";
import pino from "pino";

const log = pino({ name: "adapter:linkedin" });

const API = "https://api.linkedin.com/v2";

export type LinkedInPayload = {
  contentId: string;
  title: string;
  bodyMd: string;
  /** Signed URL for the visual asset (poster / OG image) */
  assetSignedUrl?: string;
  /**
   * Multi-image URLs — accepted for payload-shape symmetry with other
   * adapters, but LinkedIn UGC feed posts don't support multi-image. The
   * adapter takes the first entry and drops the rest with a warning. The
   * publish step already caps to maxImagesForChannel=1, so this is a
   * defence-in-depth check.
   */
  assetSignedUrls?: string[];
};

async function liRequest<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LinkedIn ${method} ${path} → ${res.status}: ${text}`);
  }

  // DELETE returns 204 with empty body.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Upload an image asset to LinkedIn and return the asset URN.
 * LinkedIn requires a two-step: register → upload.
 */
async function uploadAssetToLinkedIn(token: string, orgUrn: string, imageUrl: string): Promise<string> {
  // Step 1: Register the upload.
  const { value } = await liRequest<{
    value: { uploadMechanism: { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: string } }; asset: string };
  }>("POST", "/assets?action=registerUpload", token, {
    registerUploadRequest: {
      owner: orgUrn,
      recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
      serviceRelationships: [
        { identifier: "urn:li:userGeneratedContent", relationshipType: "OWNER" },
      ],
    },
  });

  const uploadUrl = value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
  const assetUrn = value.asset;

  // Step 2: Fetch the image and PUT it to LinkedIn's upload URL.
  const imgRes = await fetch(imageUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!imgRes.ok) throw new Error(`Failed to fetch asset for LinkedIn upload: ${imgRes.status}`);
  const imgBuffer = await imgRes.arrayBuffer();

  await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
    body: imgBuffer,
    signal: AbortSignal.timeout(60_000),
  });

  return assetUrn;
}

export type LinkedInCreds = {
  accessToken: string;
  /** URN to post as: either urn:li:person:{sub} or urn:li:organization:{id}. */
  authorUrn: string;
};

/**
 * LinkedIn UGC Posts adapter.
 * Publishes text-only or image posts on behalf of the authorized member or
 * organization. Credentials come from the per-workspace social_connections
 * row populated by /api/oauth/linkedin/callback.
 */
export class LinkedInAdapter implements PublishingAdapter<LinkedInPayload> {
  readonly channel: Channel = "linkedin";
  private readonly token: string;
  private readonly orgUrn: string;

  constructor(creds: LinkedInCreds) {
    this.token = creds.accessToken;
    this.orgUrn = creds.authorUrn;
  }

  async publish(payload: LinkedInPayload): Promise<AdapterPublishResult> {
    const { token, orgUrn } = this;

    // LinkedIn feed posts are single-image only. If the caller passed an
    // array (multi-image post cross-published), take the first and warn.
    let imageUrl = payload.assetSignedUrl;
    if (payload.assetSignedUrls && payload.assetSignedUrls.length > 0) {
      imageUrl = payload.assetSignedUrls[0];
      if (payload.assetSignedUrls.length > 1) {
        log.warn(
          { dropped: payload.assetSignedUrls.length - 1 },
          "linkedin received multi-image payload; using first only (UGC posts are single-image)",
        );
      }
    }

    log.info({ contentId: payload.contentId, hasAsset: !!imageUrl }, "linkedin publish");

    // Build the UGC post body.
    let shareMediaCategory: "NONE" | "IMAGE" = "NONE";
    const media: unknown[] = [];

    if (imageUrl) {
      try {
        const assetUrn = await uploadAssetToLinkedIn(token, orgUrn, imageUrl);
        shareMediaCategory = "IMAGE";
        media.push({
          status: "READY",
          description: { text: payload.title },
          media: assetUrn,
          title: { text: payload.title },
        });
        log.info({ assetUrn }, "asset uploaded to linkedin");
      } catch (err) {
        log.warn({ err: (err as Error).message }, "asset upload failed; continuing as text-only post");
      }
    }

    const ugcBody = {
      author: orgUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: payload.bodyMd },
          shareMediaCategory,
          ...(media.length > 0 ? { media } : {}),
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    };

    const result = await liRequest<{ id: string }>("POST", "/ugcPosts", token, ugcBody);
    const postId = result.id; // e.g. "urn:li:ugcPost:7123456789"
    const postUrl = `https://www.linkedin.com/feed/update/${postId}`;

    log.info({ postId, postUrl }, "linkedin publish succeeded");
    return { externalId: postId, externalUrl: postUrl };
  }

  async retract(externalId: string): Promise<void> {
    const { token } = this;
    log.info({ externalId }, "linkedin retract");
    const encoded = encodeURIComponent(externalId);
    await liRequest<void>("DELETE", `/ugcPosts/${encoded}`, token);
    log.info({ externalId }, "linkedin retract succeeded");
  }

  async fetchMetrics(externalId: string): Promise<Record<string, number>> {
    const { token, orgUrn } = this;
    try {
      const encoded = encodeURIComponent(orgUrn);
      const shareEncoded = encodeURIComponent(externalId);
      const data = await liRequest<{
        elements?: Array<{ totalShareStatistics: Record<string, number> }>;
      }>(
        "GET",
        `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encoded}&shares[0]=${shareEncoded}`,
        token,
      );
      const stats = data.elements?.[0]?.totalShareStatistics ?? {};
      return {
        impressions: stats.impressionCount ?? 0,
        clicks: stats.clickCount ?? 0,
        likes: stats.likeCount ?? 0,
        comments: stats.commentCount ?? 0,
        shares: stats.shareCount ?? 0,
      };
    } catch (err) {
      log.warn({ err: (err as Error).message, externalId }, "linkedin fetchMetrics failed");
      return {};
    }
  }
}
