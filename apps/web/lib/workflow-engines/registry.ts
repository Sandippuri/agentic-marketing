// Engine registry. Single source of truth for which engines exist and what
// they can do. Both the API dispatcher and the UI picker import from here
// so adding/disabling an engine is a one-file change.
//
// Phase 4 cutover dropped the "custom" engine (Manager-routed). Vercel is
// the default; Cloudflare slot remains marked unavailable until the worker
// is wired.

import { vercelEngine } from "./engines/vercel";
import { cloudflareEngine } from "./engines/cloudflare";
import type { EngineId, WorkflowEngine, WorkflowKind } from "./types";

const ENGINES: Record<EngineId, WorkflowEngine> = {
  vercel: vercelEngine,
  cloudflare: cloudflareEngine,
};

// Registry order = picker order in the UI.
const ORDER: EngineId[] = ["vercel", "cloudflare"];

export function getEngine(id: EngineId): WorkflowEngine {
  return ENGINES[id];
}

export function listEngines(): WorkflowEngine[] {
  return ORDER.map((id) => ENGINES[id]);
}

// Public-safe descriptor for the UI. Keeps the WorkflowEngine type (with
// its `start` function) out of the client bundle.
export type EngineDescriptor = {
  id: EngineId;
  label: string;
  description: string;
  available: boolean;
  kinds: WorkflowKind[];
  supportsContentRevision: boolean;
};

export function listEngineDescriptors(): EngineDescriptor[] {
  return listEngines().map((e) => ({
    id: e.id,
    label: e.label,
    description: e.description,
    available: e.capability.available,
    kinds: e.capability.kinds,
    supportsContentRevision: e.capability.supportsContentRevision,
  }));
}
