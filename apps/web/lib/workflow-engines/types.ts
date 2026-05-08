// Engine-agnostic workflow types. Each engine implementation lives in
// ./engines/<id>.ts and exports a WorkflowEngine that satisfies this shape.
// The registry composes them so the API + UI never branch on engine ids.

import type { Channel, LlmModel } from "@marketing/shared-types";

export type EngineId = "vercel" | "cloudflare";
export type WorkflowKind = "campaign" | "single_post" | "asset";

export type StartInput = {
  kind: WorkflowKind;
  request: string;
  campaignId?: string;
  contentId?: string;
  channel?: Channel;
  threadRef?: string;
  userId?: string | null;
  model?: LlmModel | string;
};

export type StartContext = {
  // workflow_runs.id minted by the dispatcher before the adapter runs.
  // Adapters that own their own workflow runtime (Vercel, Cloudflare) pass
  // this through so the workflow body can update status when it finishes.
  workflowRunId: string;
};

export type StartResult = {
  // Engine-native run id. For vercel it's the runId returned by start();
  // for cloudflare it's the workflow id.
  engineRunRef: string | null;
};

export type EngineCapability = {
  // Whether the engine can be selected at all. We register a Cloudflare slot
  // marked unavailable so the UI shows it as "coming soon".
  available: boolean;
  // Which kinds the engine knows how to run. Drives picker disabling.
  kinds: WorkflowKind[];
  // Whether the engine can revise an existing content_items row in place
  // (driven by passing `contentId` to the start input). Vercel's single-
  // post workflow inserts a fresh row today; revision requires this.
  supportsContentRevision: boolean;
};

export interface WorkflowEngine {
  id: EngineId;
  label: string;
  description: string;
  capability: EngineCapability;
  start(input: StartInput, ctx: StartContext): Promise<StartResult>;
}
