# Social OAuth setup

Per-workspace social-account connections live in `social_connections`. The
adapters that publish (`LinkedInAdapter`, `FacebookAdapter`, `InstagramAdapter`)
read tokens from that table, scoped to the workspace doing the publishing.
This doc covers what an operator must register with each provider so the
`Connect` buttons in `/onboarding` and `/integrations` actually work.

## One-time platform setup

1. Generate the at-rest encryption key (32 bytes hex):

   ```
   openssl rand -hex 32
   ```

   Put it in env as `SOCIAL_TOKEN_ENC_KEY`. Lose it → all stored tokens become
   unreadable. Rotate by re-encrypting; there's no automation for that yet.

2. Set `NEXT_PUBLIC_APP_URL` to the canonical origin (no trailing slash):
   `https://app.example.com` in prod, `http://localhost:3000` locally. Every
   provider's redirect URI is derived from this.

3. Apply the migration:

   ```
   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx \
     scripts/apply-sql.ts packages/db/drizzle/0038_social_connections.sql
   ```

## LinkedIn

- **Console**: https://www.linkedin.com/developers/apps
- **Env vars**: `LINKEDIN_OAUTH_CLIENT_ID`, `LINKEDIN_OAUTH_CLIENT_SECRET`
- **Redirect URI to register**: `${NEXT_PUBLIC_APP_URL}/api/oauth/linkedin/callback`
- **Required products** (Auth → Products tab):
  - "Sign In with LinkedIn using OpenID Connect"
  - "Share on LinkedIn"
- **Scopes the app requests**: `openid profile email w_member_social`

Posting as a Company Page rather than a personal member needs the
"Community Management API" product, which requires LinkedIn approval (1–4
weeks). After approval, swap the `authorUrn` field in the social_connections
metadata to `urn:li:organization:{id}` and add the `w_organization_social`
scope to `lib/oauth/providers/linkedin.ts` SCOPES.

## Meta (Facebook + Instagram, single connection)

- **Console**: https://developers.facebook.com/apps/
- **App type**: "Business"
- **Env vars**: `META_OAUTH_CLIENT_ID` (= App ID), `META_OAUTH_CLIENT_SECRET`
- **Redirect URI to register**: `${NEXT_PUBLIC_APP_URL}/api/oauth/meta/callback`
- **Products to add**:
  - Facebook Login for Business
  - Instagram (for IG Business publishing)
- **Permissions the app requests**:
  `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
  `instagram_basic`, `instagram_content_publish`, `business_management`
- **App Review**: required to release the above permissions to non-dev users.
  Until review passes, the OAuth dialog will only work for Facebook accounts
  added under "App Roles → Roles" as Admins/Developers/Testers.

Instagram-specific:

- The target IG account must be a Business or Creator account.
- It must be linked to a Facebook Page that the connecting user administers.
- `metadata.instagramBusinessAccountId` is populated automatically when the
  Page has a linked IG Business account — the wizard surfaces "Instagram
  connected" only when this field is present.

## X (Twitter)

- **Console**: https://developer.x.com/en/portal/dashboard
- **Project + App**: Basic tier or higher (Free tier does not include OAuth 2.0
  user-context posting at the time of writing — confirm in your dashboard).
- **App settings → User authentication settings**:
  - Type of App: **Web App**
  - App permissions: **Read and write**
  - OAuth 2.0: **Enabled**
  - Callback URI: `${NEXT_PUBLIC_APP_URL}/api/oauth/x/callback`
  - Website URL: `${NEXT_PUBLIC_APP_URL}`
- **Env vars**: `X_OAUTH_CLIENT_ID`, `X_OAUTH_CLIENT_SECRET`
- **Scopes the app requests**:
  `tweet.read tweet.write users.read offline.access`

**Known limitation**: X v1.1 media upload (used for image tweets) does NOT
accept OAuth 2.0 user tokens — only OAuth 1.0a app-context tokens. The
existing X adapter still reads `X_API_KEY` / `X_API_KEY_SECRET` /
`X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` from env so images keep working
during the migration. Per-workspace OAuth 2.0 user tokens are stored
(visible in the connected state) but not yet wired to the adapter — wiring
them up gates image-less tweets behind workspace connection; image tweets
stay on the app-context creds until X ships v2 media upload.

## TikTok

Not implemented. The TikTok publish adapter would also need to be written
(no `TikTokAdapter` exists today). When ready, add a new
`SocialProvider = "tiktok"` to `packages/shared-types/src/index.ts`, a new
handler under `apps/web/lib/oauth/providers/tiktok.ts`, and a publishing
adapter under `packages/agents/src/adapters/tiktok.ts`.

## Troubleshooting

- **"provider_not_configured" on Connect**: the corresponding
  `*_OAUTH_CLIENT_ID` / `*_OAUTH_CLIENT_SECRET` env vars aren't set.
- **"invalid_state" on callback**: the cookie expired (10 min) or the user
  finished OAuth in a different browser session. Re-click Connect.
- **Meta: "no Pages returned"**: the user connected without admin rights on
  any Facebook Page. Either add them as a Page admin or have a Page admin run
  the connection.
- **Token decryption fails after redeploy**: `SOCIAL_TOKEN_ENC_KEY` changed.
  Either restore the previous key or have users reconnect.
