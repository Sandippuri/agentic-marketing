import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import {
  CHANNELS,
  EMPTY_WORKSPACE_MARKET_CONTEXT,
  type WorkspaceMarketContext,
} from "@marketing/shared-types";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { withAudit } from "@/lib/audit";
import { getWorkspaceContext, LEGACY_WORKSPACE_ID } from "@/lib/billing";
import { clearMarketContextCache } from "@marketing/agents/market-store";

export const dynamic = "force-dynamic";

// ISO 3166-1 alpha-2 country code (e.g. "NP", "US"). Two uppercase letters.
const CountryCode = z.string().trim().regex(/^[A-Z]{2}$/, "country must be ISO 3166-1 alpha-2");
// BCP-47 language tag — kept loose ("en", "ne", "en-US") because workspaces
// will paste in whatever they have; downstream code can canonicalise.
const LanguageTag = z.string().trim().min(2).max(35);
// Region: ISO 3166-1 alpha-2 OR a free-form label up to 64 chars. Lets users
// say "South Asia" or "Bay Area" without forcing strict codes.
const RegionTag = z.string().trim().min(2).max(64);

const PatchBody = z.object({
  primaryCountry: CountryCode.nullable().optional(),
  targetRegions: z.array(RegionTag).max(32).optional(),
  languages: z.array(LanguageTag).max(16).optional(),
  primaryChannels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).optional(),
});

async function resolveWorkspaceId(request: Request, allowInternal: boolean): Promise<string> {
  if (allowInternal && isInternal(request)) {
    const headerWorkspace = request.headers.get("x-workspace-id")?.trim();
    return headerWorkspace && headerWorkspace.length > 0
      ? headerWorkspace
      : LEGACY_WORKSPACE_ID;
  }
  await getRequestActor();
  return (await getWorkspaceContext()).workspaceId;
}

function toResponse(row: {
  primaryCountry: string | null;
  targetRegions: string[] | null;
  languages: string[] | null;
  primaryChannels: string[] | null;
} | undefined): WorkspaceMarketContext {
  if (!row) return EMPTY_WORKSPACE_MARKET_CONTEXT;
  return {
    primaryCountry: row.primaryCountry ?? null,
    targetRegions: row.targetRegions ?? [],
    languages: row.languages ?? [],
    primaryChannels: row.primaryChannels ?? [],
  };
}

export async function GET(request: Request) {
  try {
    const workspaceId = await resolveWorkspaceId(request, true);
    const db = getDb();
    const [row] = await db
      .select({
        primaryCountry: schema.workspaces.primaryCountry,
        targetRegions: schema.workspaces.targetRegions,
        languages: schema.workspaces.languages,
        primaryChannels: schema.workspaces.primaryChannels,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return Response.json(toResponse(row));
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH /api/workspace/market-context — partial update of the structured
// market fields on the current workspace. Human-only; internal callers read.
export async function PATCH(request: Request) {
  try {
    const actor = await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const input = await parseJson(request, PatchBody);

    const db = getDb();
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (Object.prototype.hasOwnProperty.call(input, "primaryCountry")) {
      update.primaryCountry = input.primaryCountry ?? null;
    }
    if (input.targetRegions !== undefined) update.targetRegions = input.targetRegions;
    if (input.languages !== undefined) update.languages = input.languages;
    if (input.primaryChannels !== undefined) update.primaryChannels = input.primaryChannels;

    const after = await withAudit(
      { db, actor, action: "workspace.market_context.update", entityType: "workspace" },
      async () => {
        const [before] = await db
          .select({
            primaryCountry: schema.workspaces.primaryCountry,
            targetRegions: schema.workspaces.targetRegions,
            languages: schema.workspaces.languages,
            primaryChannels: schema.workspaces.primaryChannels,
          })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId))
          .limit(1);
        return before ?? null;
      },
      async () => {
        const [row] = await db
          .update(schema.workspaces)
          .set(update)
          .where(eq(schema.workspaces.id, workspaceId))
          .returning({
            primaryCountry: schema.workspaces.primaryCountry,
            targetRegions: schema.workspaces.targetRegions,
            languages: schema.workspaces.languages,
            primaryChannels: schema.workspaces.primaryChannels,
          });
        if (!row) throw new Error("workspace market context update returned no row");
        return row;
      },
    );

    clearMarketContextCache({ workspaceId });
    return Response.json(toResponse(after));
  } catch (err) {
    return errorResponse(err);
  }
}
