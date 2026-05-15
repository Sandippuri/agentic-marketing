// Lightweight tracker that records each orchestrator turn as a row in
// `generation_jobs` and each sub-agent invocation as a row in
// `generation_job_steps`. The /creation-workflow admin page renders these.
//
// Behaviour:
//   - The job row is created lazily on the first sub-agent invocation, so
//     pure-conversation chat turns (clarifying questions, lookups) do not
//     pollute the workflow view.
//   - All writes are best-effort. A failure to record progress must NEVER
//     interrupt the orchestrator's actual work, so every cp call is wrapped
//     in catch-and-log.

import pino from "pino";
import type { CpClient } from "@marketing/cp-client";

const log = pino({ name: "generation-tracker" });

export type StepName =
  | "strategist"
  | "content"
  | "asset"
  | "analyst"
  | "distributor"
  | "researcher";
export type JobKind =
  | "campaign"
  | "single_post"
  | "asset"
  | "analysis"
  | "publish"
  | "research"
  | "other";

export type GenerationTracker = {
  /** The id of the generation_jobs row, or null if no sub-agent has run yet. */
  getJobId(): string | null;
  /** Has at least one step been recorded? */
  hasRun(): boolean;
  /**
   * Wrap a sub-agent invocation. Records start, runs `fn`, records the
   * outcome, and returns whatever `fn` returns. Lazily creates the parent
   * generation_jobs row on first use.
   */
  recordStep<T>(
    name: StepName,
    input: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T>;
  /** Mark the parent job as completed (no-op if nothing ran). */
  complete(): Promise<void>;
  /** Mark the parent job as failed (no-op if nothing ran). */
  fail(err: unknown): Promise<void>;
  /** Update linked campaign/content as the orchestrator surfaces them. */
  link(input: { campaignId?: string | null; contentId?: string | null }): Promise<void>;
};

const STEP_TO_KIND: Record<StepName, JobKind> = {
  strategist: "campaign",
  content: "single_post",
  asset: "asset",
  analyst: "analysis",
  distributor: "publish",
  researcher: "research",
};

// Order of preference when upgrading job kind: strategist (campaign) wins
// over a follow-up content step, etc. A campaign run that calls strategist
// then content stays as 'campaign'.
const KIND_PRIORITY: Record<JobKind, number> = {
  campaign: 5,
  single_post: 4,
  publish: 3,
  asset: 2,
  analysis: 2,
  research: 1,
  other: 0,
};

export type CreateTrackerInput = {
  cp: CpClient;
  threadRef: string;
  userId: string;
  userMessage: string;
  /**
   * Fires once, the first time a sub-agent step actually starts and the
   * parent generation_jobs row has been created. The chat-handler uses
   * this to detach long-running workflows from the chat request: as soon
   * as a sub-agent fires, it replies with a tracking link and lets the
   * orchestrator finish in the background. Pure-conversation turns never
   * call this.
   */
  onFirstStep?: (jobId: string) => void;
};

export function createGenerationTracker({
  cp,
  threadRef,
  userId,
  userMessage,
  onFirstStep,
}: CreateTrackerInput): GenerationTracker {
  let jobId: string | null = null;
  let kind: JobKind = "other";
  let pending: Promise<void> = Promise.resolve();

  // Serialise mutations so step PATCHes never overtake the parent INSERT.
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    pending = pending.then(fn).catch((err) => {
      log.warn({ err: (err as Error).message }, "tracker write failed");
    });
    return pending;
  };

  const ensureJob = async (firstStep: StepName): Promise<string | null> => {
    if (jobId) return jobId;
    kind = STEP_TO_KIND[firstStep] ?? "other";
    try {
      const created = await cp.createGenerationJob({
        threadRef,
        userId,
        userMessage,
        kind,
      });
      jobId = created.id;
      log.info({ jobId, kind }, "generation job created");
      if (onFirstStep) {
        try {
          onFirstStep(jobId);
        } catch (err) {
          log.warn(
            { err: (err as Error).message },
            "onFirstStep callback threw",
          );
        }
      }
      return jobId;
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "failed to create generation job (continuing without tracking)",
      );
      return null;
    }
  };

  const upgradeKindIfNeeded = async (stepName: StepName): Promise<void> => {
    if (!jobId) return;
    const candidate = STEP_TO_KIND[stepName] ?? "other";
    if (KIND_PRIORITY[candidate] > KIND_PRIORITY[kind]) {
      const previous = kind;
      kind = candidate;
      try {
        await cp.patchGenerationJob(jobId, { kind: candidate });
      } catch (err) {
        kind = previous;
        log.warn({ err: (err as Error).message }, "failed to upgrade job kind");
      }
    }
  };

  return {
    getJobId() {
      return jobId;
    },
    hasRun() {
      return jobId !== null;
    },

    async recordStep(name, input, fn) {
      const ensuredId = await ensureJob(name);
      if (!ensuredId) {
        // Tracking unavailable — run the work anyway.
        return fn();
      }
      await upgradeKindIfNeeded(name);

      let stepId: string | null = null;
      try {
        const started = await cp.startGenerationStep(ensuredId, { name, input });
        stepId = started.id;
      } catch (err) {
        log.warn(
          { err: (err as Error).message, name },
          "failed to record step start",
        );
      }

      try {
        const output = await fn();
        if (stepId) {
          // Truncate huge outputs so we don't bloat the jsonb column. The
          // /creation-workflow page only needs a preview; full content
          // already lives on its own table.
          const safeOutput = summariseOutput(output);
          enqueue(() =>
            cp
              .finishGenerationStep(ensuredId, stepId!, {
                status: "succeeded",
                output: safeOutput,
              })
              .then(() => undefined),
          );
        }
        return output;
      } catch (err) {
        if (stepId) {
          enqueue(() =>
            cp
              .finishGenerationStep(ensuredId, stepId!, {
                status: "failed",
                error: (err as Error).message,
              })
              .then(() => undefined),
          );
        }
        throw err;
      }
    },

    async link({ campaignId, contentId }) {
      if (!jobId) return;
      const id = jobId;
      enqueue(() =>
        cp
          .patchGenerationJob(id, {
            ...(campaignId !== undefined ? { campaignId } : {}),
            ...(contentId !== undefined ? { contentId } : {}),
          })
          .then(() => undefined),
      );
    },

    async complete() {
      if (!jobId) return;
      const id = jobId;
      await enqueue(() =>
        cp
          .patchGenerationJob(id, {
            status: "completed",
            currentStep: null,
            completedAt: new Date().toISOString(),
          })
          .then(() => undefined),
      );
    },

    async fail(err) {
      if (!jobId) return;
      const id = jobId;
      const message = err instanceof Error ? err.message : String(err);
      await enqueue(() =>
        cp
          .patchGenerationJob(id, {
            status: "failed",
            error: message,
            completedAt: new Date().toISOString(),
          })
          .then(() => undefined),
      );
    },
  };
}

// Cap step output payloads so the jsonb column stays small. Strings get
// trimmed; objects are passed through with any obvious large fields trimmed.
function summariseOutput(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  }
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (json.length <= 8000) return value;
      return { _truncated: true, preview: `${json.slice(0, 4000)}…` };
    } catch {
      return { _unserialisable: true };
    }
  }
  return value;
}
