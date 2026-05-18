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
import { getWorkspaceContext, LEGACY_WORKSPACE_ID } from "@/lib/billing";
import { clearDesignSystemCache } from "@marketing/agents/design-system-store";

export const dynamic = "force-dynamic";

const SLUG = "default";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const DesignColor = z.object({
  name: z.string().min(1).max(80),
  hex: z.string().regex(HEX_RE, "expected hex like #RRGGBB"),
  role: z.enum(DESIGN_COLOR_ROLES).optional(),
  usage: z.string().max(500).optional(),
});

// Optional-string fields may arrive as `null` from the brand-extract draft
// (its LLM-facing schema uses `.nullable().optional()` so the model can emit
// `null` for unknowns). Normalize null→undefined at the boundary so the
// stored shape matches the `DesignTypography`/`DesignTokens` TS types.
const optStr = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((v): string | undefined => v ?? undefined);

const DesignTypography = z.object({
  headingFamily: optStr(120),
  bodyFamily: optStr(120),
  monoFamily: optStr(120),
  weights: z.array(z.number().int().min(100).max(900)).max(10).optional(),
  notes: optStr(2_000),
});

const DesignLogoZ = z.object({
  variant: z.enum(DESIGN_LOGO_VARIANTS),
  storagePath: z.string().min(1).max(500),
  contentType: optStr(120),
  notes: optStr(500),
});

const DesignTokens = z.object({
  spacing: optStr(2_000),
  radii: optStr(2_000),
  shadows: optStr(2_000),
  iconography: optStr(2_000),
  notes: optStr(4_000),
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
    let workspaceId: string;
    if (isInternalReq) {
      // Internal callers (workflow agents) must pass x-workspace-id so the
      // design system they read matches the user whose job they're running.
      // Fall back to LEGACY only when the header is absent (legacy seed scripts).
      const headerWorkspace = request.headers.get("x-workspace-id")?.trim();
      workspaceId = headerWorkspace && headerWorkspace.length > 0
        ? headerWorkspace
        : LEGACY_WORKSPACE_ID;
    } else {
      await getRequestActor();
      workspaceId = (await getWorkspaceContext()).workspaceId;
    }

    const db = getDb();
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
    const { workspaceId } = await getWorkspaceContext();
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
            colors: input.colors,
            typography: input.typography,
            logos: input.logos,
            tokens: input.tokens,
            updatedBy: actor.id ?? null,
          })
          .onConflictDoUpdate({
            target: [
              schema.brandDesignSystem.workspaceId,
              schema.brandDesignSystem.slug,
            ],
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

    // Invalidate the agents-side in-process cache so the next workflow run
    // picks up the new colors / logos immediately instead of waiting up to
    // 5 minutes for the TTL. We clear both the global scope and any
    // campaign-scoped entries for this workspace, since callers may have
    // hydrated either path.
    clearDesignSystemCache({ workspaceId });
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
