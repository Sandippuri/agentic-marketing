// Helpers around the workflow_runs table. Centralised so every engine
// adapter writes the same shape and the dashboard has one place to read
// from. Engine adapters call createRun() before they kick off, then the
// dispatcher patches the row with the engine-native ref once start()
// returns. Long-running workflow bodies (Vercel/Cloudflare) call
// finishRun() when they end so the dashboard can show terminal state.

import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { notifyOps } from "../alerts";
import type { EngineId, StartInput, WorkflowKind } from "./types";

// Coarse classifier so we can label alert dedup keys and pick a tone.
// Stays string-based because workflow_runs.error is plain text — by the time
// a failure reaches here the original APICallError instance is gone.
function classifyError(message: string): "quota" | "auth" | "rate_limit" | "other" {
  if (/insufficient[_ ]quota|exceeded.*quota|billing/i.test(message))
    return "quota";
  if (/unauthor|invalid[_ ]?api[_ ]?key|forbidden|401|403/i.test(message))
    return "auth";
  if (/rate[_ ]?limit|too many requests|429/i.test(message))
    return "rate_limit";
  return "other";
}

async function maybeAlertFailure(
  workflowRunId: string,
  error: string,
): Promise<void> {
  const kind = classifyError(error);
  if (kind === "other") return;
  await notifyOps(
    `:rotating_light: Workflow run failed (${kind}) — ${error.slice(0, 300)}`,
    {
      dedupKey: `workflow:${kind}`,
      context: { workflowRunId },
    },
  );
}

type CreateRunArgs = {
  engine: EngineId;
  kind: WorkflowKind;
  input: StartInput;
};

export async function createRun(args: CreateRunArgs): Promise<{ id: string }> {
  const db = getDb();
  const [row] = await db
    .insert(schema.workflowRuns)
    .values({
      workspaceId: args.input.workspaceId,
      engine: args.engine,
      kind: args.kind,
      status: "running",
      request: args.input.request,
      threadRef: args.input.threadRef ?? null,
      userId: args.input.userId ?? null,
      campaignId: args.input.campaignId ?? null,
      contentId: args.input.contentId ?? null,
      input: args.input,
    })
    .returning({ id: schema.workflowRuns.id });
  return { id: row!.id };
}

export async function attachEngineRef(
  workflowRunId: string,
  engineRunRef: string | null,
): Promise<void> {
  if (!engineRunRef) return;
  const db = getDb();
  await db
    .update(schema.workflowRuns)
    .set({ engineRunRef, updatedAt: new Date() })
    .where(eq(schema.workflowRuns.id, workflowRunId));
}

export async function failRun(
  workflowRunId: string,
  error: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.workflowRuns)
    .set({
      status: "failed",
      error,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.workflowRuns.id, workflowRunId));
  await maybeAlertFailure(workflowRunId, error);
}

export async function finishRun(
  workflowRunId: string,
  patch: {
    status: "completed" | "failed" | "cancelled";
    contentId?: string | null;
    campaignId?: string | null;
    error?: string | null;
    /**
     * Terminal output of the workflow. Persisted to workflow_runs.result so
     * the work survives when the run produced text but no DB rows (e.g.
     * Strategist that never called create_campaign). Migration 0037.
     */
    result?: unknown;
  },
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.workflowRuns)
    .set({
      status: patch.status,
      contentId: patch.contentId ?? undefined,
      campaignId: patch.campaignId ?? undefined,
      error: patch.error ?? null,
      result: patch.result === undefined ? undefined : patch.result,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.workflowRuns.id, workflowRunId));
  if (patch.status === "failed" && patch.error) {
    await maybeAlertFailure(workflowRunId, patch.error);
  }
}
