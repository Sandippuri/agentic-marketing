import type { ExchangedTokens, ProviderHandler } from "../types";

// X (Twitter) OAuth 2.0 with PKCE. Scopes:
//   - tweet.read, tweet.write, users.read: post + identify
//   - offline.access: receive a refresh token
// X tokens are short-lived (~2 hours); the refresh-token rotation lives in
// the adapter at publish time, not here.

const AUTH_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const ME_URL = "https://api.twitter.com/2/users/me";

const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"];

function basicAuth(): string {
  const id = process.env.X_OAUTH_CLIENT_ID!;
  const secret = process.env.X_OAUTH_CLIENT_SECRET!;
  return Buffer.from(`${id}:${secret}`).toString("base64");
}

export const xHandler: ProviderHandler = {
  provider: "x",
  usesPkce: true,

  isConfigured() {
    return Boolean(
      process.env.X_OAUTH_CLIENT_ID && process.env.X_OAUTH_CLIENT_SECRET,
    );
  },

  authorizeUrl({ state, codeChallenge, redirectUri }) {
    if (!codeChallenge) {
      throw new Error("x oauth requires a PKCE code challenge");
    }
    const u = new URL(AUTH_URL);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", process.env.X_OAUTH_CLIENT_ID!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  },

  async exchange({ code, codeVerifier, redirectUri }) {
    if (!codeVerifier) throw new Error("x oauth callback missing code_verifier");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: process.env.X_OAUTH_CLIENT_ID!,
    });
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basicAuth()}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!tokenRes.ok) {
      throw new Error(`x token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const token = (await tokenRes.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope?: string;
      token_type: string;
    };

    const meRes = await fetch(`${ME_URL}?user.fields=username,name`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!meRes.ok) {
      throw new Error(`x /users/me failed: ${meRes.status} ${await meRes.text()}`);
    }
    const me = (await meRes.json()) as {
      data: { id: string; username: string; name?: string };
    };

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000)
        : null,
      scopes: (token.scope ?? SCOPES.join(" ")).split(/\s+/).filter(Boolean),
      accountId: me.data.id,
      accountLabel: `@${me.data.username}`,
      metadata: {
        username: me.data.username,
        displayName: me.data.name ?? null,
      },
    };
  },
};
