import type { SocialProvider } from "@marketing/shared-types";
import { SOCIAL_PROVIDERS } from "@marketing/shared-types";
import type { ProviderHandler } from "../types";
import { linkedInHandler } from "./linkedin";
import { metaHandler } from "./meta";
import { xHandler } from "./x";

const HANDLERS: Record<SocialProvider, ProviderHandler> = {
  linkedin: linkedInHandler,
  meta: metaHandler,
  x: xHandler,
};

export function isSocialProvider(value: string): value is SocialProvider {
  return (SOCIAL_PROVIDERS as readonly string[]).includes(value);
}

export function getProviderHandler(provider: SocialProvider): ProviderHandler {
  return HANDLERS[provider];
}

export function getRedirectUri(provider: SocialProvider): string {
  // Each provider's app must list this exact URL as an allowed redirect URI
  // (see SETUP-OAUTH.md). NEXT_PUBLIC_APP_URL is the canonical origin.
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL must be set so OAuth callbacks resolve to a fixed origin",
    );
  }
  return `${base}/api/oauth/${provider}/callback`;
}
