// Resolves the global workflow LLM and per-sub-agent overrides from the
// `settings.workflow_model` and `settings.sub_agent_models` rows. Mirrors
// the get-default.ts pattern for the workflow engine — single source of
// truth so every dispatcher / orchestrator / workflow surface obeys the
// same picks made in Settings → Models.
//
// Server-only: pulls from the DB.

import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  DEFAULT_LLM_MODEL,
  resolveLlmModel,
  resolveSubAgentModelOverrides,
  type LlmModel,
  type SubAgentKind,
  type SubAgentModelOverrides,
} from "@marketing/shared-types";

export async function getDefaultWorkflowModel(): Promise<LlmModel> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, "workflow_model"));
  return resolveLlmModel(rows[0]?.value ?? DEFAULT_LLM_MODEL);
}

export async function getSubAgentModelOverrides(): Promise<SubAgentModelOverrides> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, "sub_agent_models"));
  return resolveSubAgentModelOverrides(rows[0]?.value);
}

// Both rows in one query. Useful for workflows that resolve multiple agents
// in sequence (e.g. campaign-plan → content → asset) without multiple
// round-trips.
export async function getWorkflowModelConfig(): Promise<{
  workflowModel: LlmModel;
  subAgentModels: SubAgentModelOverrides;
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, ["workflow_model", "sub_agent_models"]));
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    workflowModel: resolveLlmModel(map.workflow_model ?? DEFAULT_LLM_MODEL),
    subAgentModels: resolveSubAgentModelOverrides(map.sub_agent_models),
  };
}

// Precedence: explicit per-call override > sub-agent override > workflow
// default > built-in DEFAULT_LLM_MODEL. Validates each candidate against
// the model catalog so a stale settings row can't break a run.
export function pickSubAgentModel({
  kind,
  override,
  workflowModel,
  subAgentModels,
}: {
  kind: SubAgentKind;
  override?: LlmModel | string;
  workflowModel: LlmModel;
  subAgentModels: SubAgentModelOverrides;
}): LlmModel {
  if (override && typeof override === "string") {
    return resolveLlmModel(override);
  }
  if (subAgentModels[kind]) return subAgentModels[kind] as LlmModel;
  return workflowModel;
}

export async function resolveSubAgentModel(
  kind: SubAgentKind,
  override?: LlmModel | string,
): Promise<LlmModel> {
  const { workflowModel, subAgentModels } = await getWorkflowModelConfig();
  return pickSubAgentModel({ kind, override, workflowModel, subAgentModels });
}
