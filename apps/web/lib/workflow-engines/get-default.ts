// Resolves the global workflow engine from the `settings.workflow_engine`
// row. This is the single source of truth — every flow that starts a run
// (campaign / single_post / asset / redraft / chat) goes through this so
// the user picks once in Settings and every surface obeys.
//
// Server-only: pulls from the DB.

import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  DEFAULT_WORKFLOW_ENGINE,
  resolveWorkflowEngine,
} from "@marketing/shared-types";
import type { EngineId } from "./types";

export async function getDefaultWorkflowEngine(): Promise<EngineId> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, "workflow_engine"));
  return resolveWorkflowEngine(
    rows[0]?.value ?? DEFAULT_WORKFLOW_ENGINE,
  ) as EngineId;
}
