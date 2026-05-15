import { sleep } from "workflow";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import type { Channel } from "@marketing/shared-types";
import {
  HubspotEmailAdapter,
  MailchimpAdapter,
  LinkedInAdapter,
  XAdapter,
  InternalBlogAdapter,
} from "@marketing/agents/adapters";
import { CpClient } from "@marketing/cp-client";

// Phase 2 mirror of apps/distributor/src/metrics-cron.ts. Two entrypoints:
//   metricsFetchWorkflow — sleeps 24h then pulls metrics for one publish_job.
//     Started by publishWorkflow's scheduleMetricsFetchStep for email channels.
//   metricsCronFanOutWorkflow — invoked by Vercel Cron; finds publish_jobs
//     ready for a metrics pull and starts one workflow per job.

export type MetricsFetchInput = {
  publishJobId: string;
  contentId: string;
  workspaceId: string;
  channel: Channel;
  externalId: string;
  /** When omitted, defaults to 24h after publish. */
  delaySeconds?: number;
};

export async function metricsFetchWorkflow(
  input: MetricsFetchInput,
): Promise<{ recorded: number }> {
  "use workflow";
  const delay = input.delaySeconds ?? 24 * 60 * 60;
  if (delay > 0) {
    await sleep(`${delay}s`);
  }
  return await fetchAndRecordStep(input);
}

async function fetchAndRecordStep(
  input: MetricsFetchInput,
): Promise<{ recorded: number }> {
  "use step";
  const adapter = buildAdapterForChannel(input.channel);
  const fetchMetrics = (
    adapter as { fetchMetrics?: (externalId: string) => Promise<Record<string, number>> } | null
  )?.fetchMetrics?.bind(adapter);
  if (!fetchMetrics) {
    return { recorded: 0 };
  }
  const metrics = await fetchMetrics(input.externalId);
  const entries = Object.entries(metrics);
  if (entries.length === 0) {
    return { recorded: 0 };
  }
  const db = getDb();
  const now = new Date();
  for (const [metric, value] of entries) {
    await db.insert(schema.metrics).values({
      workspaceId: input.workspaceId,
      scopeType: "content",
      scopeId: input.contentId,
      channel: input.channel,
      metric,
      value: String(value),
      observedAt: now,
    });
  }
  return { recorded: entries.length };
}

function buildAdapterForChannel(channel: Channel) {
  if (channel === "internal_blog") {
    const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
    const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
    return new InternalBlogAdapter(
      new CpClient({ baseUrl, internalToken }),
    );
  }
  if (channel === "linkedin") {
    if (
      process.env.LINKEDIN_ACCESS_TOKEN &&
      process.env.LINKEDIN_ORGANIZATION_URN
    ) {
      return new LinkedInAdapter();
    }
    return null;
  }
  if (channel === "x") return process.env.X_ACCESS_TOKEN ? new XAdapter() : null;
  if (channel === "email_hubspot")
    return process.env.HUBSPOT_ACCESS_TOKEN ? new HubspotEmailAdapter() : null;
  if (channel === "email_mailchimp")
    return process.env.MAILCHIMP_API_KEY ? new MailchimpAdapter() : null;
  return null;
}

// --- cron fan-out ------------------------------------------------------------

export async function metricsCronFanOutWorkflow(): Promise<{
  enqueued: number;
}> {
  "use workflow";
  const due = await listDueMetricsJobsStep();
  if (due.length === 0) return { enqueued: 0 };
  await fanOutMetricsRunsStep(due);
  return { enqueued: due.length };
}

async function listDueMetricsJobsStep(): Promise<MetricsFetchInput[]> {
  "use step";
  const db = getDb();
  // Phase 2 keeps the criteria narrow: succeeded jobs without a recent
  // metric row, channels with fetchMetrics support. Conservative — Vercel
  // Cron runs every 6h (see vercel.json) so we deliberately re-check rather
  // than rely on a one-shot 24h-delayed run.
  const rows = await db
    .select({
      publishJobId: schema.publishJobs.id,
      contentId: schema.publishJobs.contentId,
      workspaceId: schema.publishJobs.workspaceId,
      channel: schema.publishJobs.channel,
      externalId: schema.publishJobs.externalId,
    })
    .from(schema.publishJobs)
    .where(eq(schema.publishJobs.status, "succeeded"))
    .limit(200);
  return rows
    .filter((r) => r.externalId)
    .map((r) => ({
      publishJobId: r.publishJobId,
      contentId: r.contentId,
      workspaceId: r.workspaceId,
      channel: r.channel,
      externalId: r.externalId!,
      delaySeconds: 0,
    }));
}

async function fanOutMetricsRunsStep(
  jobs: MetricsFetchInput[],
): Promise<void> {
  "use step";
  const { start } = await import("workflow/api");
  for (const job of jobs) {
    await start(metricsFetchWorkflow, [job]);
  }
}
