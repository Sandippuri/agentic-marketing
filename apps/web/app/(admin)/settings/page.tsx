import { eq, isNull, or } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { SettingsForm } from "./settings-form";
import { PlanUsageCard } from "./plan-usage-card";
import type { SettingsShape } from "@marketing/shared-types";
import { getWorkspaceContext } from "@/lib/billing";
import { PageHeader } from "../ui";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = await getWorkspaceContext();
  const db = getDb();

  // Read both the workspace-scoped rows and the global defaults; the
  // workspace value wins when both exist for the same key. Model + process
  // keys are now written to the global row only (see /super/models), so the
  // workspace owner sees the platform-wide choice for those.
  const rows = await db
    .select()
    .from(schema.settings)
    .where(
      or(
        eq(schema.settings.workspaceId, ctx.workspaceId),
        isNull(schema.settings.workspaceId),
      ),
    );
  const merged = new Map<string, unknown>();
  for (const row of rows) {
    const existing = merged.get(row.key);
    if (row.workspaceId === ctx.workspaceId || existing === undefined) {
      merged.set(row.key, row.value);
    }
  }
  const settings = Object.fromEntries(merged) as Partial<SettingsShape>;

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Settings"
        description="Your plan and usage, publishing caps, approval policy, and research keywords. AI model and provider picks are set platform-wide by the admin."
      />
      <PlanUsageCard />
      <SettingsForm initialSettings={settings} />
    </div>
  );
}
