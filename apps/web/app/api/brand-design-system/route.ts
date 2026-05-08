import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import {
  DESIGN_COLOR_ROLES,
  DESIGN_LOGO_VARIANTS,
  EMPTY_DESIGN_SYSTEM,
  type BrandDesignSystem,
  type DesignLogo,
} from "@marketing/shared-types";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { withAudit } from "@/lib/audit";
import { getSignedAssetUrl } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

const SLUG = "default";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const DesignColor = z.object({
  name: z.string().min(1).max(80),
  hex: z.string().regex(HEX_RE, "expected hex like #RRGGBB"),
  role: z.enum(DESIGN_COLOR_ROLES).optional(),
  usage: z.string().max(500).optional(),
});

const DesignTypography = z.object({
  headingFamily: z.string().max(120).optional(),
  bodyFamily: z.string().max(120).optional(),
  monoFamily: z.string().max(120).optional(),
  weights: z.array(z.number().int().min(100).max(900)).max(10).optional(),
  notes: z.string().max(2_000).optional(),
});

const DesignLogoZ = z.object({
  variant: z.enum(DESIGN_LOGO_VARIANTS),
  storagePath: z.string().min(1).max(500),
  contentType: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
});

const DesignTokens = z.object({
  spacing: z.string().max(2_000).optional(),
  radii: z.string().max(2_000).optional(),
  shadows: z.string().max(2_000).optional(),
  iconography: z.string().max(2_000).optional(),
  notes: z.string().max(4_000).optional(),
});

const PutBody = z.object({
  colors: z.array(DesignColor).max(64),
  typography: DesignTypography,
  logos: z.array(DesignLogoZ).max(20),
  tokens: DesignTokens,
});

export type DesignSystemResponse = BrandDesignSystem & {
  updatedBy: string | null;
  updatedAt: string | null;
  // Logos enriched with a freshly-signed URL so the admin form can preview
  // them without a second round-trip per logo.
  logos: Array<DesignLogo & { signedUrl: string | null }>;
};

async function signLogos(logos: DesignLogo[]): Promise<DesignSystemResponse["logos"]> {
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

export async function GET(request: Request) {
  try {
    const isInternalReq = isInternal(request);
    if (!isInternalReq) await getRequestActor();

    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.brandDesignSystem)
      .where(
        and(
          eq(schema.brandDesignSystem.slug, SLUG),
          isNull(schema.brandDesignSystem.campaignId),
        ),
      )
      .limit(1);

    const colors = row?.colors ?? EMPTY_DESIGN_SYSTEM.colors;
    const typography = row?.typography ?? EMPTY_DESIGN_SYSTEM.typography;
    const logos = row?.logos ?? EMPTY_DESIGN_SYSTEM.logos;
    const tokens = row?.tokens ?? EMPTY_DESIGN_SYSTEM.tokens;

    const response: DesignSystemResponse = {
      colors,
      typography,
      logos: await signLogos(logos),
      tokens,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
    return Response.json(response);
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/brand-design-system — upsert the singleton design-system row.
// Human-only. Logo uploads land via /api/brand-design-system/logos and
// produce storagePaths that the client passes back in this body.
export async function PUT(request: Request) {
  try {
    const actor = await getRequestActor();
    const input = await parseJson(request, PutBody);
    const db = getDb();

    const after = await withAudit(
      {
        db,
        actor,
        action: "brand_design_system.update",
        entityType: "brand_design_system",
      },
      async () => {
        const [row] = await db
          .select()
          .from(schema.brandDesignSystem)
          .where(
            and(
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
            slug: SLUG,
            colors: input.colors,
            typography: input.typography,
            logos: input.logos,
            tokens: input.tokens,
            updatedBy: actor.id ?? null,
          })
          .onConflictDoUpdate({
            target: schema.brandDesignSystem.slug,
            targetWhere: sql`"campaign_id" IS NULL`,
            set: {
              colors: input.colors,
              typography: input.typography,
              logos: input.logos,
              tokens: input.tokens,
              updatedBy: actor.id ?? null,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!row) throw new Error("brand_design_system upsert returned no row");
        return row;
      },
    );

    const response: DesignSystemResponse = {
      colors: after.colors,
      typography: after.typography,
      logos: await signLogos(after.logos),
      tokens: after.tokens,
      updatedBy: after.updatedBy,
      updatedAt: after.updatedAt.toISOString(),
    };
    return Response.json(response);
  } catch (err) {
    return errorResponse(err);
  }
}
