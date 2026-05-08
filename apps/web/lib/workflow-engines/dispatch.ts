// Single dispatch entry point. Validates the chosen engine can handle the
// kind, opens a workflow_runs row, then delegates to the engine adapter.
// On failure the row is patched to 'failed' so the dashboard reflects it.

import type { SubAgentKind } from "@marketing/shared-types";
import { LlmPreflightError } from "../http";
import { notifyOps } from "../alerts";
import { preflightModel } from "../llm-preflight";
import { resolveSubAgentModel } from "./get-default-model";
import { getEngine } from "./registry";
import { attachEngineRef, createRun, failRun } from "./runs";
import type { EngineId, StartInput, WorkflowKind } from "./types";

export type DispatchResult = {
  workflowRunId: string;
  engine: EngineId;
  engineRunRef: string | null;
};

// Maps a workflow kind to the sub-agent that drives it. Used to resolve
// the actual model so the dashboard chip reflects what ran rather than
// "unset".
const KIND_TO_SUB_AGENT: Record<WorkflowKind, SubAgentKind> = {
  campaign: "strategist",
  single_post: "content",
  asset: "asset",
};

export async function dispatchStart(
  engineId: EngineId,
  input: StartInput,
): Promise<DispatchResult> {
  const engine = getEngine(engineId);
  if (!engine) {
    throw new Error(`unknown engine: ${engineId}`);
  }
  if (!engine.capability.available) {
    throw new Error(`engine ${engineId} is not available`);
  }
  if (!engine.capability.kinds.includes(input.kind)) {
    throw new Error(
      `engine ${engineId} does not support kind=${input.kind}`,
    );
  }

  // Resolve the actual model that will run (override → settings → default)
  // and snapshot it onto the workflow_runs row so the dashboard chip stays
  // accurate even if global settings change later.
  const resolvedModel = await resolveSubAgentModel(
    KIND_TO_SUB_AGENT[input.kind],
    input.model,
  );
  const inputWithModel: StartInput = { ...input, model: resolvedModel };

  // Preflight the chosen model with a 1-token, no-retry call. If the provider
  // is down / out of quota / unauthorised, fail fast with a 503 instead of
  // creating a workflow_runs row that will only fail 25 seconds later mid-step.
  // Quota and auth errors also page ops so we know billing is wedged before
  // users do.
  const pre = await preflightModel(resolvedModel);
  if (!pre.ok) {
    if (pre.isQuota || pre.isAuth) {
      const kind = pre.isQuota ? "quota" : "auth";
      await notifyOps(
        `:warning: LLM preflight failed (${kind}) — ${pre.provider}: ${pre.message}`,
        {
          dedupKey: `preflight:${kind}:${pre.provider}:${pre.model}`,
          context: { model: pre.model, kind: input.kind, engine: engineId },
        },
      );
    }
    throw new LlmPreflightError({
      provider: pre.provider,
      model: pre.model,
      kind: pre.isQuota ? "quota" : pre.isAuth ? "auth" : "other",
      message: pre.message,
    });
  }

  const { id: workflowRunId } = await createRun({
    engine: engineId,
    kind: input.kind,
    input: inputWithModel,
  });

  try {
    const { engineRunRef } = await engine.start(inputWithModel, { workflowRunId });
    await attachEngineRef(workflowRunId, engineRunRef);
    return { workflowRunId, engine: engineId, engineRunRef };
  } catch (err) {
    await failRun(workflowRunId, (err as Error).message);
    throw err;
  }
}
