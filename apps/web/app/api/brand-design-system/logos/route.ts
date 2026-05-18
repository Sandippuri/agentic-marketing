import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { generateText } from "ai";
import { getDb, schema } from "@marketing/db";
import {
  DESIGN_LOGO_VARIANTS,
  EMPTY_DESIGN_SYSTEM,
  type DesignLogo,
} from "@marketing/shared-types";
import { getRequestActor } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { errorResponse, parseJson } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/billing";
import {
  uploadAsset,
  deleteAsset,
  getSignedAssetUrl,
} from "@/lib/supabase/storage";
import { clearDesignSystemCache } from "@marketing/agents/design-system-store";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import {
  getPrompt,
  LOGO_DESCRIBE_PROMPT,
} from "@marketing/agents/prompt-store";

export const dynamic = "force-dynamic";

const SLUG = "default";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/gif",
]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// POST /api/brand-design-system/logos — upload a single logo file.
// multipart/form-data with field "file". Returns the storagePath plus a
// short-lived signed URL the form can preview immediately.
export async function POST(request: Request) {
  try {
    await getRequestActor();

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
    const storagePath = `brand/logos/${crypto.randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    await uploadAsset(storagePath, buffer, contentType);
    const signedUrl = await getSignedAssetUrl(storagePath);

    // Auto-describe the logo so the image-gen prompt can verbally anchor the
    // mark alongside the attached file (bi-modal grounding). One-time cost
    // (~$0.0005 per upload on gemini-2.5-flash-lite); the description is
    // surfaced to the client so it can pre-fill the notes field. Best-effort:
    // a failure here doesn't block the upload.
    const autoNotes = await describeLogo(buffer, contentType).catch(() => null);

    return Response.json({
      storagePath,
      contentType,
      signedUrl,
      autoNotes,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

async function describeLogo(
  bytes: Buffer,
  contentType: string,
): Promise<string | null> {
  // Skip SVG — the vision model expects a raster. SVGs work as references for
  // image-gen but we can't easily inspect them without a rasteriser here.
  if (contentType === "image/svg+xml") return null;
  const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
  const systemPrompt = await getPrompt(
    "logo_describer.system",
    LOGO_DESCRIBE_PROMPT,
  );
  const { text } = await generateText({
    model: getLanguageModel("gemini-2.5-flash-lite"),
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this brand logo for reproduction." },
          { type: "image", image: dataUrl },
        ],
      },
    ],
  });
  const cleaned = text.trim().replace(/^["'`]|["'`]$/g, "").slice(0, 220);
  return cleaned || null;
}

const DesignLogoZ = z.object({
  variant: z.enum(DESIGN_LOGO_VARIANTS),
  storagePath: z.string().min(1).max(500),
  contentType: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
});

const PutBody = z.object({
  logos: z.array(DesignLogoZ).max(20),
});

async function signLogos(
  logos: DesignLogo[],
): Promise<Array<DesignLogo & { signedUrl: string | null }>> {
  return Promise.all(
    logos.map(async (logo) => {
      try {
        const signedUrl = await getSignedAssetUrl(logo.storagePath);
        return { ...logo, signedUrl };
      } catch {
        return { ...logo, signedUrl: null };
      }
    }),
  );
}

// PUT /api/brand-design-system/logos — persist just the logos array on the
// singleton design-system row. Lets the admin form save logo
// uploads/removals immediately without flushing unsaved edits to the rest of
// the design system (colors, typography, tokens).
export async function PUT(request: Request) {
  try {
    const actor = await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const input = await parseJson(request, PutBody);
    const db = getDb();

    const after = await withAudit(
      {
        db,
        actor,
        action: "brand_design_system.logos.update",
        entityType: "brand_design_system",
      },
      async () => {
        const [row] = await db
          .select()
          .from(schema.brandDesignSystem)
          .where(
            and(
              eq(schema.brandDesignSystem.workspaceId, workspaceId),
              eq(schema.brandDesignSystem.slug, SLUG),
              isNull(schema.brandDesignSystem.campaignId),
            ),
          )
          .limit(1);
        return row ?? null;
      },
      async () => {
        const [row] = await db
          .insert(schema.brandDesignSystem)
          .values({
            workspaceId,
            slug: SLUG,
            colors: EMPTY_DESIGN_SYSTEM.colors,
            typography: EMPTY_DESIGN_SYSTEM.typography,
            logos: input.logos,
            tokens: EMPTY_DESIGN_SYSTEM.tokens,
            updatedBy: actor.id ?? null,
          })
          .onConflictDoUpdate({
            target: [
              schema.brandDesignSystem.workspaceId,
              schema.brandDesignSystem.slug,
            ],
            targetWhere: sql`"campaign_id" IS NULL`,
            set: {
              logos: input.logos,
              updatedBy: actor.id ?? null,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!row) throw new Error("brand_design_system upsert returned no row");
        return row;
      },
    );

    // Invalidate the agents-side in-process cache so the next workflow run
    // picks up the new logo array immediately instead of waiting up to
    // 5 minutes for the TTL.
    clearDesignSystemCache({ workspaceId });
    return Response.json({
      logos: await signLogos(after.logos),
      updatedAt: after.updatedAt.toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const DeleteParams = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    // Restrict deletes to the brand/logos/ prefix so a tampered request can't
    // be used to nuke arbitrary asset keys.
    .refine((p) => p.startsWith("brand/logos/"), "path must be under brand/logos/"),
});

// DELETE /api/brand-design-system/logos?path=brand/logos/...
export async function DELETE(request: Request) {
  try {
    await getRequestActor();
    const url = new URL(request.url);
    const { path } = DeleteParams.parse({ path: url.searchParams.get("path") ?? "" });
    await deleteAsset(path);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
