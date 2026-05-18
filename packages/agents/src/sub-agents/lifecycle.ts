/**
 * Lifecycle / CRM sub-agent. Multi-step email sequence design.
 *
 * Tools:
 *   create_sequence — inserts a lifecycle_sequences row with ordered
 *                     lifecycle_steps. Each step either references an
 *                     existing content_items row or is left null for the
 *                     orchestrator to fill in via run_content later.
 *   list_sequences  — list sequences for a campaign (read).
 */
import { generateText, tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  getDb,
  schema,
  type NewLifecycleSequence,
  type NewLifecycleStep,
} from "@marketing/db";
import type { CpClient } from "@marketing/cp-client";
import type { LlmModel } from "@marketing/shared-types";
import { LIFECYCLE_PROMPT } from "@marketing/prompts";
import { getPrompt } from "../prompt-store";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";
import { buildKbTools } from "../tools/kb-tools";

export type LifecycleInput = {
  request: string;
  campaignId: string;
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  cp: CpClient;
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

export async function runLifecycle({
  request,
  campaignId,
  workspaceId,
  model,
  threadRef,
  jobId,
  workflowRunId,
}: LifecycleInput): Promise<string> {
  const kbTools = buildKbTools({ workspaceId, campaignId });
  const systemPrompt = await getPrompt("lifecycle.system", LIFECYCLE_PROMPT);

  const { text, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    system: systemPrompt,
    prompt: request,
    maxSteps: 6,
    tools: {
      ...kbTools,

      create_sequence: tool({
        description:
          "Create a lifecycle_sequences row and its ordered steps in one call. Returns sequenceId. Steps reference content_items by id when known; null content_id is allowed and means a step needs content drafted later.",
        parameters: z.object({
          name: z.string().min(2),
          channel: z.enum([
            "internal_blog",
            "linkedin",
            "x",
            "email_hubspot",
            "email_mailchimp",
          ]),
          audienceSegment: z.string().optional(),
          steps: z
            .array(
              z.object({
                stepIndex: z.number().int().min(0),
                contentId: z.string().uuid().nullable().optional(),
                delayHours: z.number().int().min(0).default(0),
                triggerEvent: z.string().default("previous_published"),
              }),
            )
            .min(1)
            .max(7),
        }),
        execute: async (input) => createSequence(workspaceId, campaignId, input),
      }),

      list_sequences: tool({
        description: "List lifecycle sequences for the current campaign.",
        parameters: z.object({}),
        execute: async () => listSequences(campaignId),
      }),
    },
  });

  await recordLlmUsage({
    agent: "lifecycle",
    workspaceId,
    model,
    threadRef: threadRef ?? undefined,
    jobId: jobId ?? null,
    workflowRunId: workflowRunId ?? null,
    usage,
    providerMetadata: experimental_providerMetadata,
  });

  return text;
}

async function createSequence(
  workspaceId: string,
  campaignId: string,
  input: {
    name: string;
    channel:
      | "internal_blog"
      | "linkedin"
      | "x"
      | "email_hubspot"
      | "email_mailchimp";
    audienceSegment?: string;
    steps: Array<{
      stepIndex: number;
      contentId?: string | null;
      delayHours: number;
      triggerEvent: string;
    }>;
  },
) {
  const db = getDb();
  const seq: NewLifecycleSequence = {
    workspaceId,
    campaignId,
    name: input.name,
    channel: input.channel,
    audienceSegment: input.audienceSegment ?? null,
    status: "draft",
  };
  const [seqRow] = await db
    .insert(schema.lifecycleSequences)
    .values(seq)
    .returning();
  if (!seqRow) throw new Error("lifecycle_sequences insert returned no rows");

  const stepRows: NewLifecycleStep[] = input.steps.map((s) => ({
    workspaceId,
    sequenceId: seqRow.id,
    stepIndex: s.stepIndex,
    contentId: s.contentId ?? null,
    delayHours: s.delayHours,
    triggerEvent: s.triggerEvent,
  }));
  if (stepRows.length > 0) {
    await db.insert(schema.lifecycleSteps).values(stepRows);
  }
  return { sequenceId: seqRow.id, stepCount: stepRows.length };
}

async function listSequences(campaignId: string) {
  const db = getDb();
  const seqs = await db
    .select()
    .from(schema.lifecycleSequences)
    .where(eq(schema.lifecycleSequences.campaignId, campaignId));
  if (seqs.length === 0) return [];
  const out: Array<{
    id: string;
    name: string;
    channel: string;
    status: string;
    audienceSegment: string | null;
    steps: Array<{
      stepIndex: number;
      contentId: string | null;
      delayHours: number;
    }>;
  }> = [];
  for (const s of seqs) {
    const steps = await db
      .select()
      .from(schema.lifecycleSteps)
      .where(eq(schema.lifecycleSteps.sequenceId, s.id))
      .orderBy(schema.lifecycleSteps.stepIndex);
    out.push({
      id: s.id,
      name: s.name,
      channel: s.channel as string,
      status: s.status,
      audienceSegment: s.audienceSegment,
      steps: steps.map((st) => ({
        stepIndex: st.stepIndex,
        contentId: st.contentId,
        delayHours: st.delayHours,
      })),
    });
  }
  return out;
}
