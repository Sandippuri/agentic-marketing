import type { ExchangedTokens, ProviderHandler } from "../types";

// Meta OAuth — covers BOTH Facebook and Instagram from one connection.
// Flow:
//   1. User-token authorization code → short-lived user access token.
//   2. Exchange short-lived for long-lived user token (~60 days).
//   3. GET /me/accounts → list Pages with per-Page access tokens that are
//      effectively non-expiring as long as the user token stays valid.
//   4. For each Page, /{page-id}?fields=instagram_business_account picks up
//      the linked IG Business account, if any.
//
// We persist the FIRST Page in `accountId` and stash the full Page list +
// any IG business id under `metadata` so the publish adapters can route.

const AUTH_URL = "https://www.facebook.com/v21.0/dialog/oauth";
const TOKEN_URL = "https://graph.facebook.com/v21.0/oauth/access_token";
const GRAPH = "https://graph.facebook.com/v21.0";

const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
];

type FbPage = {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  instagram_business_account?: { id: string };
};

export const metaHandler: ProviderHandler = {
  provider: "meta",
  usesPkce: false,

  isConfigured() {
    return Boolean(
      process.env.META_OAUTH_CLIENT_ID && process.env.META_OAUTH_CLIENT_SECRET,
    );
  },

  authorizeUrl({ state, redirectUri }) {
    const u = new URL(AUTH_URL);
    u.searchParams.set("client_id", process.env.META_OAUTH_CLIENT_ID!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(","));
    return u.toString();
  },

  async exchange({ code, redirectUri }) {
    // Step 1: code → short-lived user token.
    const tokenUrl = new URL(TOKEN_URL);
    tokenUrl.searchParams.set("client_id", process.env.META_OAUTH_CLIENT_ID!);
    tokenUrl.searchParams.set("client_secret", process.env.META_OAUTH_CLIENT_SECRET!);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);
    const shortRes = await fetch(tokenUrl);
    if (!shortRes.ok) {
      throw new Error(`meta short token failed: ${shortRes.status} ${await shortRes.text()}`);
    }
    const short = (await shortRes.json()) as {
      access_token: string;
      expires_in?: number;
    };

    // Step 2: short-lived → long-lived user token (~60 days).
    const longUrl = new URL(TOKEN_URL);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", process.env.META_OAUTH_CLIENT_ID!);
    longUrl.searchParams.set("client_secret", process.env.META_OAUTH_CLIENT_SECRET!);
    longUrl.searchParams.set("fb_exchange_token", short.access_token);
    const longRes = await fetch(longUrl);
    if (!longRes.ok) {
      throw new Error(`meta long token failed: ${longRes.status} ${await longRes.text()}`);
    }
    const long = (await longRes.json()) as {
      access_token: string;
      expires_in?: number;
    };

    // Step 3: list Pages with their per-Page tokens.
    const pagesUrl = new URL(`${GRAPH}/me/accounts`);
    pagesUrl.searchParams.set(
      "fields",
      "id,name,access_token,category,instagram_business_account",
    );
    pagesUrl.searchParams.set("access_token", long.access_token);
    const pagesRes = await fetch(pagesUrl);
    if (!pagesRes.ok) {
      throw new Error(`meta /me/accounts failed: ${pagesRes.status} ${await pagesRes.text()}`);
    }
    const pagesJson = (await pagesRes.json()) as { data: FbPage[] };
    const pages = pagesJson.data ?? [];
    if (pages.length === 0) {
      throw new Error(
        "no Pages returned — the connected user must be an admin of at least one Facebook Page",
      );
    }
    // First page wins for the primary connection; the full list is stashed so
    // the operator can pick a different Page later. (UI for that is future
    // work; until then we publish to pages[0].)
    const primary = pages[0]!;

    const meUrl = new URL(`${GRAPH}/me`);
    meUrl.searchParams.set("fields", "id,name");
    meUrl.searchParams.set("access_token", long.access_token);
    const meRes = await fetch(meUrl);
    const me = meRes.ok
      ? ((await meRes.json()) as { id: string; name?: string })
      : { id: "unknown" };

    const result: ExchangedTokens = {
      // We store the Page Access Token because that's what publishing uses.
      // The long-lived USER token is stashed in metadata for refresh / Page
      // re-selection.
      accessToken: primary.access_token,
      refreshToken: null,
      expiresAt: long.expires_in
        ? new Date(Date.now() + long.expires_in * 1000)
        : null,
      scopes: SCOPES,
      accountId: primary.id,
      accountLabel: `${primary.name} (Facebook Page)`,
      metadata: {
        userId: me.id,
        userName: me.name ?? null,
        userAccessToken: long.access_token,
        pages: pages.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category ?? null,
          instagramBusinessAccountId: p.instagram_business_account?.id ?? null,
        })),
        selectedPageId: primary.id,
        instagramBusinessAccountId:
          primary.instagram_business_account?.id ?? null,
      },
    };
    return result;
  },
};
