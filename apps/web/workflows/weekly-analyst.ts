import { runAnalyst } from "@marketing/agents/sub-agents/analyst";
import { CpClient } from "@marketing/cp-client";
import { resolveSubAgentModel } from "@/lib/workflow-engines";
// Deep-import: the billing index re-exports workspace-context → supabase →
// @marketing/db, which pulls `postgres` into the workflow bundle and trips
// node-js-module-in-workflow. scoped-db has no node-only deps.
import { LEGACY_WORKSPACE_ID } from "@/lib/billing/scoped-db";

// Phase 3 mirror of apps/manager/src/cron.ts. Triggered by Vercel Cron at
// 03:15 UTC every Monday (= 09:00 Asia/Kathmandu). Runs runAnalyst and
// returns the report; the cron route stores it / posts it as needed.

export type WeeklyAnalystOutput = {
  report: string;
};

export async function weeklyAnalystWorkflow(): Promise<WeeklyAnalystOutput> {
  "use workflow";
  return await runAnalystStep();
}

async function runAnalystStep(): Promise<WeeklyAnalystOutput> {
  "use step";
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  const cp = new CpClient({ baseUrl, internalToken });
  const report = await runAnalyst({
    request: [
      "Summarize last week's marketing performance.",
      "Include: which channels drove the most output, any notable publish failures,",
      "which content stage had the highest throughput.",
      "Recommend one concrete change for next week.",
      "Then write the findings to learnings/{yyyy-mm}.md.",
    ].join(" "),
    workspaceId: LEGACY_WORKSPACE_ID,
    cp,
    model: await resolveSubAgentModel("analyst"),
  });
  return { report };
}
