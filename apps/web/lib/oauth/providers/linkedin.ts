import type { ExchangedTokens, ProviderHandler } from "../types";

// LinkedIn OAuth 2.0 — three-legged. We use the standard authorization code
// flow with PKCE optional (LinkedIn supports it but doesn't require it for
// confidential clients). Scopes we request:
//   - openid, profile, email: read who connected (no special review)
//   - w_member_social: post on behalf of the connected member
// To post AS an organization we'd additionally need w_organization_social
// and the Community Management API — see SETUP-OAUTH.md.

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

const SCOPES = ["openid", "profile", "email", "w_member_social"];

export const linkedInHandler: ProviderHandler = {
  provider: "linkedin",
  usesPkce: false,

  isConfigured() {
    return Boolean(
      process.env.LINKEDIN_OAUTH_CLIENT_ID &&
        process.env.LINKEDIN_OAUTH_CLIENT_SECRET,
    );
  },

  authorizeUrl({ state, redirectUri }) {
    const u = new URL(AUTH_URL);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", process.env.LINKEDIN_OAUTH_CLIENT_ID!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", SCOPES.join(" "));
    return u.toString();
  },

  async exchange({ code, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: process.env.LINKEDIN_OAUTH_CLIENT_ID!,
      client_secret: process.env.LINKEDIN_OAUTH_CLIENT_SECRET!,
    });
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`linkedin token exchange failed: ${tokenRes.status} ${text}`);
    }
    const token = (await tokenRes.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      refresh_token_expires_in?: number;
      scope?: string;
    };

    // Pull the connected member's identity for the UI label.
    const meRes = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!meRes.ok) {
      const text = await meRes.text();
      throw new Error(`linkedin userinfo failed: ${meRes.status} ${text}`);
    }
    const me = (await meRes.json()) as {
      sub: string;
      name?: string;
      email?: string;
    };

    const memberUrn = `urn:li:person:${me.sub}`;
    const result: ExchangedTokens = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000)
        : null,
      scopes: (token.scope ?? SCOPES.join(",")).split(/[,\s]+/).filter(Boolean),
      accountId: memberUrn,
      accountLabel: me.name ?? me.email ?? memberUrn,
      metadata: {
        memberUrn,
        // Author URN used by /ugcPosts. Defaults to the personal member URN
        // — operators can swap to an org URN once Community Management API
        // access is approved (see SETUP-OAUTH.md).
        authorUrn: memberUrn,
      },
    };
    return result;
  },
};
