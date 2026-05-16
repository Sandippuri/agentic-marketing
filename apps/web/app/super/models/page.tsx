import { isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  LLM_PROVIDERS,
  type LlmProvider,
  type SettingsShape,
} from "@marketing/shared-types";
import { listEngineDescriptors } from "@/lib/workflow-engines";
import { PageHeader } from "@/app/(admin)/ui";
import { ModelsForm } from "./models-form";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Superadmin-only: every model + process knob lives here. Reads the
// global-scope rows (workspace_id IS NULL) only — that's what the rest of
// the platform falls back to once a workspace setting is absent, and now
// every model key writes here unconditionally.
function getProviderAvailability(): Record<LlmProvider, boolean> {
  const has = (provider: LlmProvider): boolean => {
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
  };
  return Object.fromEntries(
    LLM_PROVIDERS.map((p) => [p, has(p)]),
  ) as Record<LlmProvider, boolean>;
}

export default async function SuperModelsPage() {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(isNull(schema.settings.workspaceId));
  const settings = Object.fromEntries(
    rows.map((r) => [r.key, r.value]),
  ) as Partial<SettingsShape>;

  return (
    <div>
      <PageHeader
        title="Models & processes"
        description="Platform-wide AI model picks, workflow engine, search/embedding providers, and the user-facing model allowlist. Every workspace inherits these — workspace owners cannot override them."
      />
      <ModelsForm
        initialSettings={settings}
        engines={listEngineDescriptors()}
        providerAvailability={getProviderAvailability()}
      />
    </div>
  );
}
