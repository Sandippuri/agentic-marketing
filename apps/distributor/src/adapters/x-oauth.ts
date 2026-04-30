// OAuth 1.0a signing for X (Twitter) API v1.1 + v2 user-context calls.
// Node.js built-in crypto — no extra dependencies needed.

import { createHmac, randomBytes } from "node:crypto";

export type OAuth1Credentials = {
  apiKey: string;
  apiKeySecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

/**
 * Build an Authorization header value for OAuth 1.0a.
 * Implements RFC 5849 §3.4 HMAC-SHA1 signature.
 */
export function buildOAuth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  bodyParams: Record<string, string> = {},
): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Collect and sort all parameters.
  const allParams: Record<string, string> = { ...oauthParams, ...bodyParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k]!)}`)
    .join("&");

  // Build the signature base string.
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");

  // Signing key = encoded consumer secret + "&" + encoded token secret.
  const signingKey = `${percentEncode(creds.apiKeySecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  oauthParams["oauth_signature"] = signature;

  const headerValue = Object.entries(oauthParams)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");

  return `OAuth ${headerValue}`;
}

/** Get OAuth 1.0a credentials from environment variables. */
export function getXCreds(): OAuth1Credentials {
  const apiKey = process.env.X_API_KEY;
  const apiKeySecret = process.env.X_API_KEY_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;

  if (!apiKey || !apiKeySecret || !accessToken || !accessTokenSecret) {
    throw new Error(
      "X_API_KEY, X_API_KEY_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET must all be set",
    );
  }

  return { apiKey, apiKeySecret, accessToken, accessTokenSecret };
}
