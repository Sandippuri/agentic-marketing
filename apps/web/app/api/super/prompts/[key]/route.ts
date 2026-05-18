// PUT /api/super/prompts/[key] — set or reset a global prompt override.
//
// Body: { body: string } to set; { body: null } to reset to default (deletes
// the row). Storage: settings table with workspace_id IS NULL and key
// "prompt:<registry-key>". Reuses the existing JSONB value column — no
// migration. Audit log entry per change. In-process agent cache is
// invalidated on save so subsequent runs pick up the new body within ~1s.

import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  clearPromptCache,
  getRegistryEntry,
} from "@marketing/agents/prompt-store";
import { requireSuperadmin } from "@/lib/billing/admin";
import { withAudit } from "@/lib/audit";
import { errorResponse, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const PutBody = z.object({
  // null clears the override (reset to default)
  body: z.string().min(1).max(50_000).nullable(),
});

function settingKey(registryKey: string): string {
  return `prompt:${registryKey}`;
}

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ key: string }> },
) {
  try {
    const actor = await requireSuperadmin();
    const { key } = await ctx.params;
    const entry = getRegistryEntry(key);
    if (!entry) {
      return Response.json({ error: "unknown_prompt_key", key }, { status: 404 });
    }
    const input = await parseJson(request, PutBody);
    const db = getDb();
    const storageKey = settingKey(key);

    const after = await withAudit(
      {
        db,
        actor: { id: actor.userId, kind: "human" as const },
        action: input.body === null ? "prompt.reset" : "prompt.update",
        entityType: "settings",
      },
      async () => {
        const [row] = await db
          .select()
          .from(schema.settings)
          .where(
            and(
              isNull(schema.settings.workspaceId),
              eq(schema.settings.key, storageKey),
            ),
          )
          .limit(1);
        return row ?? null;
      },
      async () => {
        if (input.body === null) {
          // Reset = delete the override row; agents fall through to default.
          await db
            .delete(schema.settings)
            .where(
              and(
                isNull(schema.settings.workspaceId),
                eq(schema.settings.key, storageKey),
              ),
            );
          return { key, body: null, updatedAt: new Date().toISOString() };
        }
        // Upsert by hand because the settings table's unique index includes
        // workspace_id and onConflictDoUpdate doesn't compose with NULL the
        // way we'd want.
        const existing = await db
          .select()
          .from(schema.settings)
          .where(
            and(
              isNull(schema.settings.workspaceId),
              eq(schema.settings.key, storageKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          const [row] = await db
            .update(schema.settings)
            .set({ value: { body: input.body }, updatedAt: new Date() })
            .where(
              and(
                isNull(schema.settings.workspaceId),
                eq(schema.settings.key, storageKey),
              ),
            )
            .returning();
          if (!row) throw new Error("update returned no row");
          return {
            key,
            body: input.body,
            updatedAt: row.updatedAt.toISOString(),
          };
        }
        const [row] = await db
          .insert(schema.settings)
          .values({
            workspaceId: null,
            key: storageKey,
            value: { body: input.body },
          })
          .returning();
        if (!row) throw new Error("insert returned no row");
        return {
          key,
          body: input.body,
          updatedAt: row.updatedAt.toISOString(),
        };
      },
    );

    // Same-process cache invalidation — Vercel workflow runtimes carry their
    // own caches and pick up changes within their 5-min TTL.
    clearPromptCache();
    return Response.json(after);
  } catch (err) {
    return errorResponse(err);
  }
}
