// Google Analytics 4 Data API client.
// Requires: GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_JSON (JSON key file contents) in env.
// Docs: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
//
// Quota: 10 requests/second, 50,000 requests/project/day.
// We apply an in-memory TTL cache (1 hour) to avoid hammering the API.

import pino from "pino";
import { createSign } from "node:crypto";

const log = pino({ name: "ga4-client" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GA4RunReportParams = {
  dimensions: string[];
  metrics: string[];
  /** Filter by campaign name dimension, e.g. the UTM campaign slug */
  campaignFilter?: string;
  /** ISO date e.g. "2026-01-01" or "30daysAgo" */
  startDate?: string;
  endDate?: string;
};

export type GA4Row = {
  dimensions: Record<string, string>;
  metrics: Record<string, string>;
};

export type GA4ReportResult = {
  rows: GA4Row[];
  rowCount: number;
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = { expiresAt: number; data: GA4ReportResult };
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map<string, CacheEntry>();

function cacheKey(params: GA4RunReportParams): string {
  return JSON.stringify(params);
}

function getFromCache(params: GA4RunReportParams): GA4ReportResult | null {
  const entry = cache.get(cacheKey(params));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(params));
    return null;
  }
  return entry.data;
}

function setCache(params: GA4RunReportParams, data: GA4ReportResult): void {
  cache.set(cacheKey(params), { expiresAt: Date.now() + CACHE_TTL_MS, data });
}

// ---------------------------------------------------------------------------
// JWT / OAuth 2.0 for service accounts
// ---------------------------------------------------------------------------

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
};

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function getAccessToken(sa: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.write(signingInput);
  sign.end();
  const signature = base64url(sign.sign(sa.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GA4 token exchange failed (${res.status}): ${text}`);
  }

  const json = await res.json() as { access_token: string };
  return json.access_token;
}

// Cache the access token separately (expires in 1 hour).
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GA4_SERVICE_ACCOUNT_JSON must be set");
  const sa: ServiceAccountKey = JSON.parse(raw);
  const token = await getAccessToken(sa);
  tokenCache = { token, expiresAt: Date.now() + 3_500_000 }; // ~58 min
  return token;
}

// ---------------------------------------------------------------------------
// runReport
// ---------------------------------------------------------------------------

/**
 * Run a GA4 report. Results are cached for 1 hour to stay within quota.
 * Pass `campaignFilter` to narrow to a specific utm_campaign value.
 */
export async function runGA4Report(params: GA4RunReportParams): Promise<GA4ReportResult> {
  const cached = getFromCache(params);
  if (cached) {
    log.debug({ campaignFilter: params.campaignFilter }, "GA4 cache hit");
    return cached;
  }

  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) throw new Error("GA4_PROPERTY_ID must be set");

  const token = await getToken();

  const body: Record<string, unknown> = {
    dimensions: params.dimensions.map((name) => ({ name })),
    metrics: params.metrics.map((name) => ({ name })),
    dateRanges: [
      {
        startDate: params.startDate ?? "30daysAgo",
        endDate: params.endDate ?? "today",
      },
    ],
  };

  if (params.campaignFilter) {
    body["dimensionFilter"] = {
      filter: {
        fieldName: "sessionCampaignName",
        stringFilter: { matchType: "EXACT", value: params.campaignFilter },
      },
    };
  }

  log.info({ propertyId, dimensions: params.dimensions, metrics: params.metrics }, "GA4 runReport");

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GA4 runReport failed (${res.status}): ${text}`);
  }

  const json = await res.json() as {
    dimensionHeaders?: { name: string }[];
    metricHeaders?: { name: string }[];
    rows?: Array<{ dimensionValues: { value: string }[]; metricValues: { value: string }[] }>;
    rowCount?: number;
  };

  const dimNames = (json.dimensionHeaders ?? []).map((h) => h.name);
  const metNames = (json.metricHeaders ?? []).map((h) => h.name);

  const rows: GA4Row[] = (json.rows ?? []).map((r) => {
    const dimensions: Record<string, string> = {};
    const metrics: Record<string, string> = {};
    dimNames.forEach((name, i) => { dimensions[name] = r.dimensionValues[i]?.value ?? ""; });
    metNames.forEach((name, i) => { metrics[name] = r.metricValues[i]?.value ?? ""; });
    return { dimensions, metrics };
  });

  const result: GA4ReportResult = { rows, rowCount: json.rowCount ?? rows.length };
  setCache(params, result);
  log.info({ rowCount: result.rowCount }, "GA4 report fetched + cached");
  return result;
}
