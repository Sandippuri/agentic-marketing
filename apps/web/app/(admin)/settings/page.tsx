import { getDb, schema } from "@marketing/db";
import { SettingsForm } from "./settings-form";
import type { SettingsShape } from "@marketing/shared-types";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const db = getDb();
  const rows = await db.select().from(schema.settings);
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<SettingsShape>;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-2">Settings</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-8">
        Kill switch, channel publishing caps, and approval policy.
      </p>
      <SettingsForm initialSettings={settings} />
    </div>
  );
}
