import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/billing";
import { errorResponse } from "@/lib/http";
import { isSocialProvider } from "@/lib/oauth/providers";
import { deleteConnection } from "@/lib/oauth/repository";

export const dynamic = "force-dynamic";

// DELETE /api/oauth/[provider] — disconnect this workspace from the provider.
// Removes the encrypted-token row; we don't currently call the provider's
// revoke endpoint (Meta/X both have one — TODO once we hit a real need).

export async function DELETE(
  _request: Request,
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

    const { workspaceId } = await getWorkspaceContext();
    await deleteConnection(workspaceId, provider);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
