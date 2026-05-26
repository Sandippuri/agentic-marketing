import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { errorResponse } from "@/lib/http";
import {
  getProviderHandler,
  getRedirectUri,
  isSocialProvider,
} from "@/lib/oauth/providers";
import { clearStateCookie, readStateCookie } from "@/lib/oauth/state-cookie";
import { upsertConnection } from "@/lib/oauth/repository";

export const dynamic = "force-dynamic";
// Provider round-trip can be slow.
export const maxDuration = 30;

// GET /api/oauth/[provider]/callback?code=...&state=...
//
// Exchanges the auth code via the provider handler, persists the encrypted
// tokens, then redirects the user back to the original return_to URL with a
// success/error query param the UI can render.

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

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (providerError) {
      return redirectBack(request, "/onboarding", {
        oauth: provider,
        status: "error",
        message: url.searchParams.get("error_description") ?? providerError,
      });
    }
    if (!code || !state) {
      return NextResponse.json({ error: "missing_code_or_state" }, { status: 400 });
    }

    const payload = await readStateCookie(state);
    await clearStateCookie();
    if (!payload || payload.provider !== provider) {
      return NextResponse.json({ error: "invalid_state" }, { status: 400 });
    }

    const handler = getProviderHandler(provider);
    const tokens = await handler.exchange({
      code,
      codeVerifier: payload.codeVerifier,
      redirectUri: getRedirectUri(provider),
    });

    await upsertConnection({
      workspaceId: payload.workspaceId,
      provider,
      accountId: tokens.accountId,
      accountLabel: tokens.accountLabel,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      metadata: tokens.metadata,
    });

    return redirectBack(request, payload.returnTo, {
      oauth: provider,
      status: "connected",
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function redirectBack(
  request: Request,
  returnTo: string,
  qs: Record<string, string>,
): Response {
  const url = new URL(returnTo, request.url);
  for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}
