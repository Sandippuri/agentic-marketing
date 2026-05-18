// GET /api/super/prompts/internal — internal-token-guarded read of all global
// prompt overrides. Called by packages/agents/prompt-store on every agent
// process (cached 5 min). Kept separate from the superadmin-facing routes so
// the agent runtime doesn't need a Supabase session.

import { and, eq, isNull, like } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { assertInternal } from "@/lib/internal-auth";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertInternal(request);
    const db = getDb();
    // Stored as settings rows scoped to the global workspace (workspace_id IS
    // NULL) under the `prompt.` key prefix. We filter on both so other global
    // settings (image_model, etc.) don't leak into the prompt overrides view.
    const rows = await db
      .select({ key: schema.settings.key, value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          isNull(schema.settings.workspaceId),
          like(schema.settings.key, "prompt:%"),
        ),
      );
    const overrides = rows
      .map((r) => ({
        key: r.key.replace(/^prompt:/, ""),
        body: typeof r.value === "string" ? r.value : (r.value as { body?: string })?.body ?? "",
      }))
      .filter((p) => p.body.length > 0);
    return Response.json({ overrides });
  } catch (err) {
    return errorResponse(err);
  }
}
