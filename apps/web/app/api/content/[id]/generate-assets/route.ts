import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { generateAssetVariants } from "@/lib/asset-variants";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";
import { LEGACY_WORKSPACE_ID, getWorkspaceContext } from "@/lib/billing";

// POST /api/content/:id/generate-assets — synchronously generate visual
// variants for a content item. Used by the approvals UI as a manual
// retry/trigger when the post-submit background task didn't produce assets
// (Replicate failure, slow generation, etc.).
//
// Runs in the request lifecycle (not via after()) so any error is reported
// back to the admin instead of vanishing into the dev server logs.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const isInternalCall = isInternal(request);
    if (!isInternalCall) await getRequestActor();
    // Resolve the workspace from the content row itself rather than from the
    // session — internal callers don't carry a session and the synchronous
    // user path must scope to the row's tenant regardless of which workspace
    // the user is currently switched into.
    const db = getDb();
    const [row] = await db
      .select({ workspaceId: schema.contentItems.workspaceId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, id))
      .limit(1);
    if (!row) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const wsId = row.workspaceId ?? LEGACY_WORKSPACE_ID;

    // Cross-tenant guard for the user-session path.
    if (!isInternalCall) {
      const ctxWs = await getWorkspaceContext();
      if (ctxWs.workspaceId !== wsId) {
        return Response.json(
          { error: "content_not_in_workspace" },
          { status: 404 },
        );
      }
    }

    const result = await generateAssetVariants({
      contentId: id,
      workspaceId: wsId,
    });
    // generateAssetVariants swallows per-variant failures (it's also used by
    // background tasks). For this synchronous admin-triggered path, surface
    // an "all variants failed" outcome as an error so the UI can show it.
    if (result.inserted === 0) {
      return Response.json(
        { error: "All image variants failed — check server logs" },
        { status: 502 },
      );
    }
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
