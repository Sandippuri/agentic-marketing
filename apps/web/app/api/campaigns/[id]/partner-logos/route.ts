// POST /api/campaigns/[id]/partner-logos — upload a partner brand mark
// GET  /api/campaigns/[id]/partner-logos — list current partner logos (signed)
//
// Why: campaigns frequently promote a partner whose brand is NOT the
// workspace brand (e.g. Rizz Education promoting Arden University). Without
// an attached reference image for the partner, the image model fabricates a
// plausible-looking crest from the partner's name in the copy. These routes
// let the user upload the real mark; asset-pipeline signs it on every run
// and prepends it to the model's reference images alongside the brand logo.
//
// Storage: assets bucket, prefix `partner-logos/<workspaceId>/<campaignId>/`.
// Metadata lives on campaigns.visualIdentity.partner_logos (reused JSONB —
// no schema migration).

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { getWorkspaceContext } from "@/lib/billing/workspace-context";
import { errorResponse } from "@/lib/http";
import { getSignedAssetUrl, uploadAsset } from "@/lib/supabase/storage";
import type {
  PartnerLogo,
  VisualIdentity,
} from "@marketing/agents/sub-agents/strategist";

export const dynamic = "force-dynamic";

const IdParam = z.string().uuid();

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const MAX_BYTES = 5 * 1024 * 1024;
// Cap is deliberately conservative — the image model reference array is also
// capped (MAX_IMAGE_INPUTS=4 in concept-to-prompt), and brand logos consume
// the first 1-2 slots. Leaves room for partner refs without dropping brand.
const MAX_PARTNER_LOGOS = 3;

async function loadCampaign(id: string, workspaceId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.id, id),
        eq(schema.campaigns.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function readPartnerLogos(visualIdentity: unknown): PartnerLogo[] {
  const vi = (visualIdentity ?? null) as VisualIdentity | null;
  return Array.isArray(vi?.partner_logos) ? vi.partner_logos : [];
}

function writePartnerLogos(
  visualIdentity: unknown,
  logos: PartnerLogo[],
): VisualIdentity {
  const existing = (visualIdentity ?? null) as VisualIdentity | null;
  // The strategist's four fields default to empty when no identity was set
  // yet — keeps the column shape valid.
  return {
    recurring_motifs: existing?.recurring_motifs ?? [],
    color_mood: existing?.color_mood ?? "",
    art_style: existing?.art_style ?? "",
    banned_aesthetics: existing?.banned_aesthetics ?? [],
    partner_logos: logos,
  };
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const { id } = await ctx.params;
    const campaignId = IdParam.parse(id);

    const campaign = await loadCampaign(campaignId, workspaceId);
    if (!campaign) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const logos = readPartnerLogos(campaign.visualIdentity);
    // Sign URLs for the UI. Per-entry try/catch — one missing storage object
    // shouldn't break the whole list view.
    const signed = await Promise.all(
      logos.map(async (logo) => {
        try {
          const url = await getSignedAssetUrl(logo.storagePath);
          return { ...logo, signedUrl: url };
        } catch {
          return { ...logo, signedUrl: null as string | null };
        }
      }),
    );
    return Response.json({ logos: signed });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const { id } = await ctx.params;
    const campaignId = IdParam.parse(id);

    const form = await request.formData();
    const file = form.get("file");
    const labelRaw = form.get("label");
    if (!(file instanceof File)) {
      return Response.json({ error: "missing file" }, { status: 400 });
    }
    const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
    if (!label) {
      return Response.json({ error: "missing label" }, { status: 400 });
    }
    if (label.length > 80) {
      return Response.json({ error: "label too long" }, { status: 400 });
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

    const db = getDb();
    const existing = await loadCampaign(campaignId, workspaceId);
    if (!existing) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const current = readPartnerLogos(existing.visualIdentity);
    if (current.length >= MAX_PARTNER_LOGOS) {
      return Response.json(
        { error: "too_many_logos", max: MAX_PARTNER_LOGOS },
        { status: 409 },
      );
    }

    const logoId = crypto.randomUUID();
    const ext = EXT_BY_TYPE[contentType] ?? "bin";
    const storagePath = `partner-logos/${workspaceId}/${campaignId}/${logoId}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadAsset(storagePath, buffer, contentType);

    const entry: PartnerLogo = {
      id: logoId,
      storagePath,
      label,
      contentType,
      addedAt: new Date().toISOString(),
    };
    const next = writePartnerLogos(existing.visualIdentity, [...current, entry]);

    const updated = await withAudit(
      { db, actor, action: "campaign.partner_logo.add", entityType: "campaigns" },
      async () => existing,
      async () => {
        const [row] = await db
          .update(schema.campaigns)
          .set({ visualIdentity: next, updatedAt: new Date() })
          .where(eq(schema.campaigns.id, campaignId))
          .returning();
        if (!row) throw new Error("not_found");
        return row;
      },
    );

    const signedUrl = await getSignedAssetUrl(storagePath).catch(() => null);

    return Response.json({
      logo: { ...entry, signedUrl },
      campaignId: updated.id,
    });
  } catch (err) {
    // Best-effort: if we already uploaded the file but the DB write failed,
    // leave the orphaned object — re-uploads use fresh UUIDs so it won't
    // collide. Storage cleanup is a separate cron concern.
    return errorResponse(err);
  }
}
