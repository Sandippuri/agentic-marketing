import type { Channel, PublishingAdapter, AdapterPublishResult } from "@marketing/shared-types";
import pino from "pino";
import { buildOAuth1Header, getXCreds } from "./x-oauth";

const log = pino({ name: "adapter:x" });

const V2 = "https://api.twitter.com/2";
const V1_UPLOAD = "https://upload.twitter.com/1.1/media/upload.json";

export type XPayload = {
  contentId: string;
  bodyMd: string;
  /**
   * For x_thread: pass each tweet as a separate element.
   * If omitted, `bodyMd` is posted as a single tweet.
   * Tweets > 280 chars are split by the caller.
   */
  tweets?: string[];
  /** Single-asset URL — legacy field, kept for back-compat. */
  assetSignedUrl?: string;
  /**
   * Multi-image URLs. X attaches up to 4 media_ids to a single tweet (the
   * head tweet for threads). Extras beyond 4 are dropped at the adapter
   * layer; the publish step already caps to maxImagesForChannel.
   */
  assetSignedUrls?: string[];
};

async function tweetV2(
  text: string,
  opts: {
    inReplyToId?: string;
    mediaIds?: string[];
  } = {},
): Promise<{ id: string; text: string }> {
  const creds = getXCreds();
  const url = `${V2}/tweets`;

  const body: Record<string, unknown> = { text };
  if (opts.inReplyToId) body["reply"] = { in_reply_to_tweet_id: opts.inReplyToId };
  if (opts.mediaIds?.length) body["media"] = { media_ids: opts.mediaIds };

  const bodyStr = JSON.stringify(body);
  const authHeader = buildOAuth1Header("POST", url, creds);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: bodyStr,
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`X POST /2/tweets → ${res.status}: ${text}`);
  }

  const json = await res.json() as { data: { id: string; text: string } };
  return json.data;
}

/**
 * Upload a media asset to X v1.1 media upload endpoint.
 * Returns the `media_id_string` for attaching to tweets.
 */
async function uploadMediaToX(assetUrl: string): Promise<string> {
  const creds = getXCreds();

  const imgRes = await fetch(assetUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!imgRes.ok) throw new Error(`Failed to fetch asset for X upload: ${imgRes.status}`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const base64 = buffer.toString("base64");
  const mediaType = imgRes.headers.get("content-type") ?? "image/png";

  const params = new URLSearchParams({
    media_data: base64,
    media_type: mediaType,
  });
  const bodyStr = params.toString();

  const authHeader = buildOAuth1Header("POST", V1_UPLOAD, creds, {
    media_type: mediaType,
  });

  const res = await fetch(V1_UPLOAD, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyStr,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`X media upload → ${res.status}: ${text}`);
  }

  const json = await res.json() as { media_id_string: string };
  return json.media_id_string;
}

/**
 * X (Twitter) v2 adapter.
 * Supports single posts and thread chaining via `in_reply_to_tweet_id`.
 * Requires: X_API_KEY, X_API_KEY_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.
 */
export class XAdapter implements PublishingAdapter<XPayload> {
  readonly channel: Channel = "x";

  async publish(payload: XPayload): Promise<AdapterPublishResult> {
    const tweets = payload.tweets?.length ? payload.tweets : [payload.bodyMd];

    // Normalize URL inputs. X allows up to 4 media per tweet; cap defensively
    // here even though publish.ts caps at maxImagesForChannel.
    const urls =
      payload.assetSignedUrls && payload.assetSignedUrls.length > 0
        ? payload.assetSignedUrls.slice(0, 4)
        : payload.assetSignedUrl
          ? [payload.assetSignedUrl]
          : [];

    // Optional media upload — attached to the first tweet only. Upload each
    // URL in parallel; if one fails, we still post with whatever succeeded
    // rather than dropping the whole tweet's image.
    let mediaIds: string[] | undefined;
    if (urls.length > 0) {
      const results = await Promise.allSettled(urls.map((u) => uploadMediaToX(u)));
      const ok = results
        .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
        .map((r) => r.value);
      if (ok.length > 0) {
        mediaIds = ok;
        log.info({ mediaCount: ok.length, requested: urls.length }, "media uploaded to X");
      } else {
        log.warn(
          { requested: urls.length },
          "all X media uploads failed; continuing without images",
        );
      }
    }

    if (tweets.length === 1) {
      return this._publishSingle(tweets[0]!, mediaIds);
    }

    return this._publishThread(tweets, mediaIds);
  }

  private async _publishSingle(text: string, mediaIds?: string[]): Promise<AdapterPublishResult> {
    const tweet = await tweetV2(text, { mediaIds });
    const url = `https://x.com/i/web/status/${tweet.id}`;
    log.info({ tweetId: tweet.id }, "X single post succeeded");
    return { externalId: tweet.id, externalUrl: url };
  }

  private async _publishThread(
    tweets: string[],
    firstMediaIds?: string[],
  ): Promise<AdapterPublishResult> {
    log.info({ count: tweets.length }, "X thread publish starting");

    const publishedIds: string[] = [];
    let replyTo: string | undefined;

    for (let i = 0; i < tweets.length; i++) {
      const text = tweets[i]!;
      try {
        const mediaIds = i === 0 ? firstMediaIds : undefined;
        const tweet = await tweetV2(text, { inReplyToId: replyTo, mediaIds });
        publishedIds.push(tweet.id);
        replyTo = tweet.id;
        log.debug({ tweetId: tweet.id, position: i }, "thread tweet published");
      } catch (err) {
        // Partial-failure handling: we've already published i tweets.
        // Record partial success and surface the error.
        const partialUrl =
          publishedIds.length > 0
            ? `https://x.com/i/web/status/${publishedIds[0]}`
            : "";
        log.error(
          { err: (err as Error).message, publishedCount: publishedIds.length, totalCount: tweets.length },
          "X thread partial failure",
        );
        throw Object.assign(
          new Error(
            `X thread partial failure: ${publishedIds.length}/${tweets.length} tweets published. ${(err as Error).message}`,
          ),
          { publishedIds, partialUrl },
        );
      }
    }

    const headUrl = `https://x.com/i/web/status/${publishedIds[0]}`;
    log.info({ headId: publishedIds[0], count: publishedIds.length }, "X thread succeeded");
    return {
      externalId: publishedIds[0]!,
      externalUrl: headUrl,
    };
  }

  async retract(externalId: string): Promise<void> {
    const creds = getXCreds();
    const url = `${V2}/tweets/${externalId}`;
    const authHeader = buildOAuth1Header("DELETE", url, creds);

    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`X DELETE /2/tweets/${externalId} → ${res.status}: ${text}`);
    }
    log.info({ externalId }, "X retract succeeded");
  }

  async fetchMetrics(externalId: string): Promise<Record<string, number>> {
    try {
      const creds = getXCreds();
      const url = `${V2}/tweets/${externalId}?tweet.fields=public_metrics`;
      const authHeader = buildOAuth1Header("GET", url, creds);

      const res = await fetch(url, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return {};

      const json = await res.json() as {
        data?: { public_metrics?: Record<string, number> };
      };
      const m = json.data?.public_metrics ?? {};
      return {
        likes: m["like_count"] ?? 0,
        retweets: m["retweet_count"] ?? 0,
        replies: m["reply_count"] ?? 0,
        impressions: m["impression_count"] ?? 0,
      };
    } catch (err) {
      log.warn({ err: (err as Error).message, externalId }, "X fetchMetrics failed");
      return {};
    }
  }
}
