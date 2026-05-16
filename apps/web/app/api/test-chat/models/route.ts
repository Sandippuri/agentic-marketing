import { isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_USER_ALLOWED_MODELS,
  LLM_MODELS,
  PROVIDER_LABELS,
  type LlmProvider,
} from "@marketing/shared-types";
import { getRequestActor } from "@/lib/auth";
import { lookupAdminRole } from "@/lib/billing/admin";

function providerHasKey(provider: LlmProvider): boolean {
  switch (provider) {
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "openai":
      return !!process.env.OPENAI_API_KEY;
    case "google":
      return !!(
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY
      );
  }
}

export async function GET() {
  const actor = await getRequestActor();
  const role = actor.id ? await lookupAdminRole(actor.id) : null;
  const isSuperadmin = role === "superadmin";

  const providerAvailable = LLM_MODELS.filter((m) => providerHasKey(m.provider));

  let visible = providerAvailable;
  if (!isSuperadmin) {
    const db = getDb();
    const rows = await db
      .select({ key: schema.settings.key, value: schema.settings.value })
      .from(schema.settings)
      .where(isNull(schema.settings.workspaceId));
    const raw = rows.find((r) => r.key === "user_allowed_models")?.value;
    const allowlist =
      Array.isArray(raw) && raw.length > 0
        ? (raw as string[])
        : [...DEFAULT_USER_ALLOWED_MODELS];
    const allowed = new Set(allowlist);
    visible = providerAvailable.filter((m) => allowed.has(m.id));
  }

  const defaultId = visible.some((m) => m.id === DEFAULT_LLM_MODEL)
    ? DEFAULT_LLM_MODEL
    : visible[0]?.id;

  return Response.json({
    default: defaultId,
    providerLabels: PROVIDER_LABELS,
    models: visible,
  });
}
