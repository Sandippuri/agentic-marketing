import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { withAudit } from "@/lib/audit";
import { getWorkspaceContext } from "@/lib/billing";
import { lookupAdminRole } from "@/lib/billing/admin";
import {
  CHANNELS,
  EMBEDDING_MODELS,
  EMBEDDING_PROVIDERS,
  IMAGE_MODELS,
  LLM_MODELS,
  RESEARCH_SEARCH_PROVIDERS,
  SUB_AGENT_KINDS,
  VIDEO_MODELS,
  WORKFLOW_ENGINES,
} from "@marketing/shared-types";
import type { SettingsShape } from "@marketing/shared-types";

const IMAGE_MODEL_IDS = IMAGE_MODELS.map((m) => m.id) as [string, ...string[]];
const VIDEO_MODEL_IDS = VIDEO_MODELS.map((m) => m.id) as [string, ...string[]];
const LLM_MODEL_IDS = LLM_MODELS.map((m) => m.id) as [string, ...string[]];
const EMBEDDING_MODEL_IDS = EMBEDDING_MODELS.filter((m) => m.wired).map(
  (m) => m.id,
) as [string, ...string[]];

export const dynamic = "force-dynamic";

// Internal + authenticated admin callers may read settings.
//
// Read order:
//   1. Workspace-scoped rows for the caller's active workspace.
//   2. Global fallback rows (workspace_id IS NULL) for keys not in step 1.
// Workspace value wins. Internal-token callers read only the global rows
// because they don't carry a workspace context.
export async function GET(request: Request) {
  try {
    const isInternalReq = isInternal(request);
    if (!isInternalReq) await getRequestActor(); // throws 401 if unauthenticated
    const db = getDb();

    const workspaceId = isInternalReq
      ? null
      : (await getWorkspaceContext()).workspaceId;

    const globalRows = await db
      .select()
      .from(schema.settings)
      .where(isNull(schema.settings.workspaceId));

    const merged: Record<string, unknown> = Object.fromEntries(
      globalRows.map((r) => [r.key, r.value]),
    );

    if (workspaceId) {
      const wsRows = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.workspaceId, workspaceId));
      for (const r of wsRows) merged[r.key] = r.value;
    }

    return Response.json(merged as Partial<SettingsShape>);
  } catch (err) {
    return errorResponse(err);
  }
}

const PatchSettings = z.object({
  kill_switch: z.boolean().optional(),
  channel_caps: z.record(z.enum(CHANNELS), z.number().int().min(0)).optional(),
  approval_policy: z
    .object({
      mode: z.enum(["single", "two_approver"]),
      channels: z.array(z.enum(CHANNELS)).optional(),
    })
    .optional(),
  image_model: z.enum(IMAGE_MODEL_IDS).optional(),
  video_model: z.enum(VIDEO_MODEL_IDS).optional(),
  video_generation_enabled: z.boolean().optional(),
  workflow_engine: z.enum(WORKFLOW_ENGINES).optional(),
  workflow_model: z.enum(LLM_MODEL_IDS).optional(),
  brand_extract_model: z.enum(LLM_MODEL_IDS).optional(),
  // Per-sub-agent overrides. Send `null` for a kind to clear it (drops the
  // entry server-side); send a model id to pin that kind.
  sub_agent_models: z
    .record(z.enum(SUB_AGENT_KINDS), z.enum(LLM_MODEL_IDS).nullable())
    .optional(),
  research_keywords: z
    .array(z.string().trim().min(1).max(120))
    .max(50)
    .optional(),
  research_search_provider: z.enum(RESEARCH_SEARCH_PROVIDERS).optional(),
  embedding_provider: z.enum(EMBEDDING_PROVIDERS).optional(),
  embedding_model: z.enum(EMBEDDING_MODEL_IDS).optional(),
  // Platform-wide user model allowlist. Only the superadmin should send
  // this; the workspace-scoped write is rejected below.
  user_allowed_models: z.array(z.enum(LLM_MODEL_IDS)).max(64).optional(),
});

// PATCH /api/settings — upsert one or more settings keys for the active
// workspace. Internal token callers write to the global fallback row
// (workspace_id NULL) so legacy /api/* calls continue to set process-wide
// defaults.
export async function PATCH(request: Request) {
  try {
    const isInternalReq = isInternal(request);
    const actor = isInternalReq
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const workspaceId = isInternalReq
      ? null
      : (await getWorkspaceContext()).workspaceId;

    const input = await parseJson(request, PatchSettings);
    const db = getDb();

    const entries = Object.entries(input).filter(([, v]) => v !== undefined) as [string, unknown][];
    if (entries.length === 0) {
      return Response.json({ error: "no fields to update" }, { status: 400 });
    }

    // Every model + process knob is superadmin-only. Workspace owners only
    // get to set publishing controls (kill switch, channel caps, approval
    // policy) and their research keyword list. The UI hides these controls
    // entirely from non-superadmins; this is the server-side enforcement.
    const SUPERADMIN_KEYS = new Set([
      "user_allowed_models",
      "image_model",
      "video_model",
      "video_generation_enabled",
      "workflow_engine",
      "workflow_model",
      "brand_extract_model",
      "sub_agent_models",
      "research_search_provider",
      "embedding_provider",
      "embedding_model",
    ]);
    const hasRestrictedKey = entries.some(([k]) => SUPERADMIN_KEYS.has(k));
    if (hasRestrictedKey && !isInternalReq) {
      const role = actor.id ? await lookupAdminRole(actor.id) : null;
      if (role !== "superadmin") {
        return Response.json(
          { error: "superadmin_required" },
          { status: 403 },
        );
      }
    }

    // Build the predicate for finding "the row for this (workspace, key)".
    // Every superadmin-controlled key writes to the global row
    // (workspace_id IS NULL) so the choice propagates to every workspace.
    // Per-workspace settings (kill switch, channel caps, approval policy,
    // research keywords) still scope to the caller's active workspace.
    const GLOBAL_KEYS = new Set([
      "user_allowed_models",
      "image_model",
      "video_model",
      "video_generation_enabled",
      "workflow_engine",
      "workflow_model",
      "brand_extract_model",
      "sub_agent_models",
      "research_search_provider",
      "embedding_provider",
      "embedding_model",
    ]);
    const scopeFor = (key: string): string | null =>
      GLOBAL_KEYS.has(key) ? null : workspaceId;
    const rowFilter = (key: string) => {
      const ws = scopeFor(key);
      return ws
        ? and(
            eq(schema.settings.workspaceId, ws),
            eq(schema.settings.key, key),
          )
        : and(isNull(schema.settings.workspaceId), eq(schema.settings.key, key));
    };

    await withAudit(
      { db, actor, action: "settings.update", entityType: "settings" },
      async () => {
        const rows = await db
          .select()
          .from(schema.settings)
          .where(
            workspaceId
              ? eq(schema.settings.workspaceId, workspaceId)
              : isNull(schema.settings.workspaceId),
          );
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
      },
      async () => {
        for (const [key, rawValue] of entries) {
          let value: unknown = rawValue;
          // sub_agent_models merges into the existing row for this scope.
          if (key === "sub_agent_models") {
            const [existing] = await db
              .select()
              .from(schema.settings)
              .where(rowFilter("sub_agent_models"))
              .limit(1);
            const current = (existing?.value as Record<string, string> | null) ?? {};
            const patch = rawValue as Record<string, string | null>;
            const next: Record<string, string> = { ...current };
            for (const [k, v] of Object.entries(patch)) {
              if (v === null) delete next[k];
              else next[k] = v;
            }
            value = next;
          }

          // No native ON CONFLICT target works against the coalesce-based
          // composite unique, so do an explicit upsert.
          const [existing] = await db
            .select()
            .from(schema.settings)
            .where(rowFilter(key))
            .limit(1);
          if (existing) {
            await db
              .update(schema.settings)
              .set({ value, updatedBy: actor.id ?? null, updatedAt: new Date() })
              .where(rowFilter(key));
          } else {
            await db.insert(schema.settings).values({
              workspaceId: scopeFor(key),
              key,
              value,
              updatedBy: actor.id ?? null,
            });
          }
        }
        return null;
      },
    );

    // Return merged view (workspace + global fallback) for the caller.
    const globalRows = await db
      .select()
      .from(schema.settings)
      .where(isNull(schema.settings.workspaceId));
    const merged: Record<string, unknown> = Object.fromEntries(
      globalRows.map((r) => [r.key, r.value]),
    );
    if (workspaceId) {
      const wsRows = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.workspaceId, workspaceId));
      for (const r of wsRows) merged[r.key] = r.value;
    }
    return Response.json(merged);
  } catch (err) {
    return errorResponse(err);
  }
}
