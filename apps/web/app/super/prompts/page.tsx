import { and, isNull, like } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  PROMPT_REGISTRY,
  type PromptRegistryEntry,
} from "@marketing/agents/prompt-store";
import { PageHeader } from "@/app/(admin)/ui";
import { PromptsList, type PromptView } from "./prompts-list";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Superadmin-only: every prompt that drives the agentic flow, editable from
// here. Layout enforces superadmin role; no extra guard needed.
export default async function SuperPromptsPage() {
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
        body:
          typeof r.value === "string"
            ? r.value
            : (r.value as { body?: string })?.body ?? "",
        updatedAt: r.updatedAt.toISOString(),
      },
    ]),
  );

  const prompts: PromptView[] = PROMPT_REGISTRY.map(
    (entry: PromptRegistryEntry) => {
      const override = overrideByKey.get(entry.key);
      return {
        ...entry,
        currentBody: override?.body ?? entry.defaultBody,
        hasOverride: Boolean(override),
        overrideUpdatedAt: override?.updatedAt ?? null,
      };
    },
  );

  return (
    <div>
      <PageHeader
        title="Prompts"
        description="Every prompt that drives the agentic flow. Edits take effect on the next workflow run (~5 min cache for sub-agents running in the workflow runtime). High-risk prompts can break tool calls — test before saving."
      />
      <PromptsList prompts={prompts} />
    </div>
  );
}
