import { generateAssetVariants } from "@/lib/asset-variants";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";

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
    if (!isInternal(request)) await getRequestActor();

    const result = await generateAssetVariants({ contentId: id });
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
