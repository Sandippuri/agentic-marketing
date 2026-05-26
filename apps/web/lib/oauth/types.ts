import type { SocialProvider } from "@marketing/shared-types";

// Result of a successful token exchange — what each provider's handler
// returns. The shape is the same so the generic callback route can persist
// it without provider branching.
export type ExchangedTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  /** Provider-side account id (member URN / Page ID / user id). */
  accountId: string;
  /** Human-readable label for the UI. */
  accountLabel: string;
  /** Provider-specific extras stored as JSON. */
  metadata: Record<string, unknown>;
};

export type AuthorizeUrlArgs = {
  state: string;
  codeChallenge?: string;
  redirectUri: string;
};

export type ExchangeArgs = {
  code: string;
  codeVerifier?: string;
  redirectUri: string;
};

export type ProviderHandler = {
  provider: SocialProvider;
  /** Whether the OAuth app credentials are present in env. */
  isConfigured(): boolean;
  /** Whether this provider's flow needs PKCE. */
  usesPkce: boolean;
  /** Build the URL we redirect the user to. */
  authorizeUrl(args: AuthorizeUrlArgs): string;
  /** Exchange the code → tokens + account info. */
  exchange(args: ExchangeArgs): Promise<ExchangedTokens>;
};
