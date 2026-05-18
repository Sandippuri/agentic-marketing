// GET /api/super/prompts — superadmin-only list of every editable prompt with
// its default body, current override (if any), and metadata. Drives the
// /super/prompts page.

import { and, isNull, like } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  PROMPT_REGISTRY,
  type PromptRegistryEntry,
} from "@marketing/agents/prompt-store";
import { requireSuperadmin } from "@/lib/billing/admin";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperadmin();
    const db = getDb();
    const rows = await db
      .select({
        key: schema.settings.key,
        value: schema.settings.value,
        updatedAt: schema.settings.updatedAt,
      })
      .from(schema.settings)
      .where(
        and(
          isNull(schema.settings.workspaceId),
          like(schema.settings.key, "prompt:%"),
        ),
      );

    const overrideByKey = new Map(
      rows.map((r) => [
        r.key.replace(/^prompt:/, ""),
        {
          body: typeof r.value === "string" ? r.value : (r.value as { body?: string })?.body ?? "",
          updatedAt: r.updatedAt.toISOString(),
        },
      ]),
    );

    const prompts = PROMPT_REGISTRY.map((entry: PromptRegistryEntry) => {
      const override = overrideByKey.get(entry.key);
      return {
        ...entry,
        currentBody: override?.body ?? entry.defaultBody,
        hasOverride: Boolean(override),
        overrideUpdatedAt: override?.updatedAt ?? null,
      };
    });

    return Response.json({ prompts });
  } catch (err) {
    return errorResponse(err);
  }
}
