// POST /api/uploads/inspiration-images
//
// Accepts a user-uploaded reference image used as visual inspiration for the
// asset pipeline. The returned storagePath is passed back on the workflow
// start body (inspirationImagePath) and threaded into concept-to-prompt as a
// reference image alongside brand logos.
//
// Throwaway by design — these are mood/style references, not brand assets,
// and live under `inspiration/<workspaceId>/` so a future cleanup job can
// expire them without touching anything else.

import { errorResponse } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import { getWorkspaceContext } from "@/lib/billing";
import { uploadAsset, getSignedAssetUrl } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_BYTES = 5 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export async function POST(request: Request) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "missing file" }, { status: 400 });
    }
    const contentType = file.type || "application/octet-stream";
    if (!ALLOWED_TYPES.has(contentType)) {
      return Response.json(
        { error: "unsupported_type", contentType },
        { status: 415 },
      );
    }
    if (file.size > MAX_BYTES) {
      return Response.json(
        { error: "too_large", maxBytes: MAX_BYTES },
        { status: 413 },
      );
    }

    const ext = EXT_BY_TYPE[contentType] ?? "bin";
    const storagePath = `inspiration/${workspaceId}/${crypto.randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    await uploadAsset(storagePath, buffer, contentType);
    const signedUrl = await getSignedAssetUrl(storagePath);

    return Response.json({ storagePath, contentType, signedUrl });
  } catch (err) {
    return errorResponse(err);
  }
}
