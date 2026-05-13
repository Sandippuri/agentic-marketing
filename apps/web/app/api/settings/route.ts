import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { withAudit } from "@/lib/audit";
import {
  CHANNELS,
  EMBEDDING_MODELS,
  EMBEDDING_PROVIDERS,
  IMAGE_MODELS,
  LLM_MODELS,
  RESEARCH_SEARCH_PROVIDERS,
  SUB_AGENT_KINDS,
  WORKFLOW_ENGINES,
} from "@marketing/shared-types";
import type { SettingsShape } from "@marketing/shared-types";

const IMAGE_MODEL_IDS = IMAGE_MODELS.map((m) => m.id) as [string, ...string[]];
const LLM_MODEL_IDS = LLM_MODELS.map((m) => m.id) as [string, ...string[]];
const EMBEDDING_MODEL_IDS = EMBEDDING_MODELS.filter((m) => m.wired).map(
  (m) => m.id,
) as [string, ...string[]];

export const dynamic = "force-dynamic";

// Internal + authenticated admin callers may read settings.
export async function GET(request: Request) {
  try {
    const isInternalReq = isInternal(request);
    if (!isInternalReq) await getRequestActor(); // throws 401 if unauthenticated
    const db = getDb();
    const rows = await db.select().from(schema.settings);
    const obj = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return Response.json(obj as Partial<SettingsShape>);
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
});

// PATCH /api/settings — upsert one or more settings keys.
// Authenticated admin users and internal token callers may write.
export async function PATCH(request: Request) {
  try {
    const isInternalReq = isInternal(request);
    const actor = isInternalReq
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();

    const input = await parseJson(request, PatchSettings);
    const db = getDb();

    const entries = Object.entries(input).filter(([, v]) => v !== undefined) as [string, unknown][];
    if (entries.length === 0) {
      return Response.json({ error: "no fields to update" }, { status: 400 });
    }

    await withAudit(
      { db, actor, action: "settings.update", entityType: "settings" },
      async () => {
        const rows = await db.select().from(schema.settings);
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
      },
      async () => {
        for (const [key, rawValue] of entries) {
          let value: unknown = rawValue;
          // sub_agent_models is the only key that needs merge semantics:
          // callers send a partial patch (e.g. { content: "claude-opus-4-7" }
          // or { content: null } to clear). We merge into the existing row
          // so other kinds keep their pinned models.
          if (key === "sub_agent_models") {
            const [existing] = await db
              .select()
              .from(schema.settings)
              .where(eq(schema.settings.key, "sub_agent_models"))
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
          await db
            .insert(schema.settings)
            .values({ key, value, updatedBy: actor.id ?? null })
            .onConflictDoUpdate({
              target: schema.settings.key,
              set: { value, updatedBy: actor.id ?? null, updatedAt: new Date() },
            });
        }
        return null;
      },
    );

    const rows = await db.select().from(schema.settings);
    return Response.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch (err) {
    return errorResponse(err);
  }
}
