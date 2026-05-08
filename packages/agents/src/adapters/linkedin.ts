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
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch asset for LinkedIn upload: ${imgRes.status}`);
  const imgBuffer = await imgRes.arrayBuffer();

  await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
    body: imgBuffer,
  });

  return assetUrn;
}

/**
 * LinkedIn UGC Posts adapter.
 * Publishes text-only or image posts to a company page.
 * Requires: LINKEDIN_ACCESS_TOKEN, LINKEDIN_ORGANIZATION_URN in env.
 */
export class LinkedInAdapter implements PublishingAdapter<LinkedInPayload> {
  readonly channel: Channel = "linkedin";

  async publish(payload: LinkedInPayload): Promise<AdapterPublishResult> {
    const token = process.env.LINKEDIN_ACCESS_TOKEN;
    const orgUrn = process.env.LINKEDIN_ORGANIZATION_URN; // e.g. "urn:li:organization:12345"

    if (!token || !orgUrn) {
      throw new Error("LINKEDIN_ACCESS_TOKEN and LINKEDIN_ORGANIZATION_URN must be set");
    }

    log.info({ contentId: payload.contentId, hasAsset: !!payload.assetSignedUrl }, "linkedin publish");

    // Build the UGC post body.
    let shareMediaCategory: "NONE" | "IMAGE" = "NONE";
    const media: unknown[] = [];

    if (payload.assetSignedUrl) {
      try {
        const assetUrn = await uploadAssetToLinkedIn(token, orgUrn, payload.assetSignedUrl);
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
    const token = process.env.LINKEDIN_ACCESS_TOKEN;
    if (!token) throw new Error("LINKEDIN_ACCESS_TOKEN must be set");

    log.info({ externalId }, "linkedin retract");
    // Encode the URN for use in a URL path segment.
    const encoded = encodeURIComponent(externalId);
    await liRequest<void>("DELETE", `/ugcPosts/${encoded}`, token);
    log.info({ externalId }, "linkedin retract succeeded");
  }

  async fetchMetrics(externalId: string): Promise<Record<string, number>> {
    const token = process.env.LINKEDIN_ACCESS_TOKEN;
    if (!token) return {};

    try {
      const orgUrn = process.env.LINKEDIN_ORGANIZATION_URN ?? "";
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
