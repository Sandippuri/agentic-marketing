/**
 * X (Twitter) profile reader tool for the Researcher sub-agent.
 *
 * Reads a public profile's recent posts via the X API v2:
 *   - GET /2/users/by/username/:handle
 *   - GET /2/users/:id/tweets (with media expansions)
 *
 * Returns normalised JSON: profile metadata + array of posts with text,
 * timestamps, public metrics, and media URLs. The LLM then decides what to
 * persist into the KB via kb_write_finding; images can be archived to
 * Supabase Storage via the companion kb_archive_image tool.
 *
 * Auth: prefers X_BEARER_TOKEN (app-only, simpler). Falls back to OAuth 1.0a
 * user-context using the existing X_API_KEY / X_ACCESS_TOKEN credentials.
 *
 * NOTE: reading user timelines requires X API Basic tier ($100/mo) or higher.
 */
import { tool } from "ai";
import { z } from "zod";
import { buildOAuth1Header, getXCreds } from "../adapters/x-oauth";

const V2 = "https://api.twitter.com/2";

type XMedia = {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
};

type XTweet = {
  id: string;
  text: string;
  created_at?: string;
  public_metrics?: Record<string, number>;
  attachments?: { media_keys?: string[] };
};

function authHeader(method: string, url: string): { Authorization: string } {
  const bearer = process.env.X_BEARER_TOKEN;
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  // Fall back to OAuth1 user context using publish creds.
  const creds = getXCreds();
  // The URL passed to buildOAuth1Header should be the base URL without query
  // params; query params are signed separately. Split here.
  const [base, query] = url.split("?");
  const bodyParams: Record<string, string> = {};
  if (query) {
    for (const pair of query.split("&")) {
      const [k, v] = pair.split("=");
      if (k) bodyParams[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  return { Authorization: buildOAuth1Header(method, base!, creds, bodyParams) };
}

async function xGet<T>(path: string): Promise<T> {
  const url = `${V2}${path}`;
  const res = await fetch(url, { headers: authHeader("GET", url) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`X GET ${path} → ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export function buildXProfileTool() {
  return {
    x_read_profile: tool({
      description:
        "Read a public X (Twitter) profile's recent posts. Returns profile metadata and an array of recent tweets with text, created_at, public_metrics, and media URLs (image/video). Use this when the user asks to learn from or archive someone's X posts — typically followed by kb_archive_image (for any images worth keeping) and kb_write_finding (to persist a summary into the KB). Requires X API Basic tier or higher; respect rate limits by capping maxTweets.",
      parameters: z.object({
        handle: z
          .string()
          .min(1)
          .max(40)
          .describe("X username without the leading @ (e.g. 'verufinance')"),
        maxTweets: z
          .number()
          .int()
          .min(5)
          .max(100)
          .optional()
          .default(50)
          .describe("How many recent tweets to fetch (1 API page, max 100)."),
        excludeReplies: z.boolean().optional().default(true),
        excludeRetweets: z.boolean().optional().default(true),
      }),
      execute: async ({ handle, maxTweets, excludeReplies, excludeRetweets }) => {
        try {
          const cleanHandle = handle.replace(/^@/, "").trim();
          const userResp = await xGet<{
            data?: {
              id: string;
              name: string;
              username: string;
              description?: string;
              verified?: boolean;
              profile_image_url?: string;
              public_metrics?: Record<string, number>;
            };
            errors?: Array<{ detail?: string; title?: string }>;
          }>(
            `/users/by/username/${encodeURIComponent(cleanHandle)}?user.fields=description,verified,profile_image_url,public_metrics`,
          );
          if (!userResp.data) {
            return {
              error: `X user @${cleanHandle} not found`,
              details: userResp.errors,
            };
          }
          const user = userResp.data;

          const exclusions = [
            excludeReplies ? "replies" : null,
            excludeRetweets ? "retweets" : null,
          ]
            .filter(Boolean)
            .join(",");

          const params = new URLSearchParams({
            max_results: String(maxTweets),
            "tweet.fields": "created_at,public_metrics,attachments,entities",
            expansions: "attachments.media_keys",
            "media.fields": "type,url,preview_image_url,alt_text,width,height",
          });
          if (exclusions) params.set("exclude", exclusions);

          const timeline = await xGet<{
            data?: XTweet[];
            includes?: { media?: XMedia[] };
            meta?: { result_count: number; next_token?: string };
          }>(`/users/${user.id}/tweets?${params.toString()}`);

          const mediaByKey = new Map<string, XMedia>();
          for (const m of timeline.includes?.media ?? []) {
            mediaByKey.set(m.media_key, m);
          }

          const tweets = (timeline.data ?? []).map((t) => {
            const mediaKeys = t.attachments?.media_keys ?? [];
            const media = mediaKeys
              .map((k) => mediaByKey.get(k))
              .filter((m): m is XMedia => Boolean(m))
              .map((m) => ({
                type: m.type,
                url: m.url ?? m.preview_image_url ?? null,
                altText: m.alt_text ?? null,
              }));
            return {
              id: t.id,
              text: t.text,
              url: `https://x.com/${user.username}/status/${t.id}`,
              createdAt: t.created_at ?? null,
              metrics: t.public_metrics ?? {},
              media,
            };
          });

          return {
            profile: {
              id: user.id,
              handle: user.username,
              name: user.name,
              bio: user.description ?? "",
              verified: user.verified ?? false,
              profileImageUrl: user.profile_image_url ?? null,
              metrics: user.public_metrics ?? {},
            },
            tweets,
            count: tweets.length,
          };
        } catch (err) {
          return { error: (err as Error).message, handle };
        }
      },
    }),
  };
}
