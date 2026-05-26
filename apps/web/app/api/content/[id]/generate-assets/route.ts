import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import { generateAssetVariants } from "@/lib/asset-variants";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";
import { LEGACY_WORKSPACE_ID, getWorkspaceContext } from "@/lib/billing";

// Optional body: { slotIndex?: number }. When omitted, every slot in
// content_items.image_brief regenerates. When set, only that slot does.
const GenerateBody = z
  .object({ slotIndex: z.number().int().min(0).max(3).optional() })
  .optional();

// POST /api/content/:id/generate-assets — synchronously generate visual
// variants for a content item. Used by the approvals UI as a manual
// retry/trigger when the post-submit background task didn't produce assets
// (Replicate failure, slow generation, etc.). Passing { slotIndex } scopes
// the regen to a single image slot.
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
    // Body is optional — bare POST keeps the legacy "regen all slots" call
    // working unchanged. parse() rejects payloads with unexpected fields.
    let body: { slotIndex?: number } | undefined;
    try {
      const raw = (await request.json().catch(() => null)) as unknown;
      body = raw ? (GenerateBody.parse(raw) ?? undefined) : undefined;
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
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
      slotIndex: body?.slotIndex,
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
