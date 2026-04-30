import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import { isInternal } from "@/lib/internal-auth";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { withAudit } from "@/lib/audit";
import { CHANNELS } from "@marketing/shared-types";
import type { SettingsShape } from "@marketing/shared-types";

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
        for (const [key, value] of entries) {
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
