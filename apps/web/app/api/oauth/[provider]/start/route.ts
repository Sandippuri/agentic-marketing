import { randomBytes, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/billing";
import { errorResponse } from "@/lib/http";
import {
  getProviderHandler,
  getRedirectUri,
  isSocialProvider,
} from "@/lib/oauth/providers";
import { setStateCookie } from "@/lib/oauth/state-cookie";

export const dynamic = "force-dynamic";

// GET /api/oauth/[provider]/start
//   ?return_to=/onboarding   (optional, defaults to /onboarding)
//
// Redirects the user to the provider's authorize URL. On callback we
// upsert a social_connections row for the current workspace.

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  try {
    const sb = await getSupabaseServer();
    const { data: userData } = await sb.auth.getUser();
    if (!userData.user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { provider } = await ctx.params;
    if (!isSocialProvider(provider)) {
      return NextResponse.json({ error: "unknown_provider" }, { status: 404 });
    }

    const handler = getProviderHandler(provider);
    if (!handler.isConfigured()) {
      return NextResponse.json(
        {
          error: "provider_not_configured",
          message: `Set the ${provider.toUpperCase()}_OAUTH_CLIENT_ID and _CLIENT_SECRET env vars. See SETUP-OAUTH.md.`,
        },
        { status: 503 },
      );
    }

    const { workspaceId } = await getWorkspaceContext();

    const url = new URL(request.url);
    const returnTo = url.searchParams.get("return_to") ?? "/onboarding";
    // Only allow same-origin returns to avoid open redirects.
    if (!returnTo.startsWith("/")) {
      return NextResponse.json({ error: "invalid_return_to" }, { status: 400 });
    }

    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (handler.usesPkce) {
      codeVerifier = b64url(randomBytes(48));
      codeChallenge = b64url(
        createHash("sha256").update(codeVerifier).digest(),
      );
    }

    const nonce = await setStateCookie({
      workspaceId,
      provider,
      returnTo,
      codeVerifier,
    });

    const authorizeUrl = handler.authorizeUrl({
      state: nonce,
      codeChallenge,
      redirectUri: getRedirectUri(provider),
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (err) {
    return errorResponse(err);
  }
}
