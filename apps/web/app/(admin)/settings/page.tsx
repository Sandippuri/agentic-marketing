import { getDb, schema } from "@marketing/db";
import { SettingsForm } from "./settings-form";
import { UsagePanel } from "./usage-panel";
import {
  LLM_PROVIDERS,
  type LlmProvider,
  type SettingsShape,
} from "@marketing/shared-types";
import { listEngineDescriptors } from "@/lib/workflow-engines";
import { PageHeader } from "../ui";

export const dynamic = "force-dynamic";

// Mirrors /api/test-chat/models — gate model rows in the picker on whichever
// provider keys are actually configured. Detected server-side so the UI can
// render disabled rows without an extra fetch.
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

export default async function SettingsPage() {
  const db = getDb();
  const rows = await db.select().from(schema.settings);
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<SettingsShape>;
  const engines = listEngineDescriptors();
  const providerAvailability = getProviderAvailability();

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Settings"
        description="Kill switch, per-channel publishing caps, and approval policy. Changes apply within five minutes."
      />
      <SettingsForm
        initialSettings={settings}
        engines={engines}
        providerAvailability={providerAvailability}
        usagePanel={<UsagePanel />}
      />
    </div>
  );
}
