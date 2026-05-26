-- Migration 0038: social_connections — per-workspace OAuth tokens for
-- LinkedIn, Meta (Facebook + Instagram), and X. Replaces the legacy
-- env-var-only credentials used by buildAdapters().
--
-- Tokens are stored encrypted via AES-256-GCM (see apps/web/lib/oauth/
-- encryption.ts); the column holds the ciphertext + iv + tag in a single
-- base64 blob. Refresh tokens may be null for providers (e.g. Meta long-lived
-- Page tokens) that don't issue them.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0038_social_connections.sql

CREATE TYPE "social_provider" AS ENUM ('linkedin', 'meta', 'x');

CREATE TABLE IF NOT EXISTS "social_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" social_provider NOT NULL,
  -- Provider-side account identifier. LinkedIn: member URN or org URN.
  -- Meta: Facebook Page ID (plus IG business id in metadata). X: user id.
  "account_id" text NOT NULL,
  -- Human-readable label shown in the UI ("Acme Inc on LinkedIn").
  "account_label" text NOT NULL,
  -- Encrypted blob (base64 of iv|tag|ciphertext).
  "access_token_enc" text NOT NULL,
  "refresh_token_enc" text,
  "expires_at" timestamptz,
  -- Granted scopes, as the provider returned them.
  "scopes" text[] NOT NULL DEFAULT '{}',
  -- Provider-specific extras: org URN, FB Page list, IG business id, etc.
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "last_refreshed_at" timestamptz
);

-- One connection per (workspace, provider). Re-connecting overwrites the row.
CREATE UNIQUE INDEX IF NOT EXISTS "social_connections_workspace_provider_idx"
  ON "social_connections" ("workspace_id", "provider");
