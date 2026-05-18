import { generateText, tool, type CoreMessage } from "ai";
import { z } from "zod";
import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { STRATEGIST_PROMPT } from "@marketing/prompts";
import { getPrompt } from "../prompt-store";
import { buildBaseMemory, buildVisualMemory, loadMemory, loadMemoryDir } from "../memory";
import { findSimilarContent } from "../find-similar";
import { findBrandGuidance } from "../brand-guidance";
import {
  formatMarketBlock,
  getWorkspaceMarketContext,
} from "../market-store";
import { CHANNELS, type LlmModel } from "@marketing/shared-types";
import { getLanguageModel } from "../llm-registry";
import { recordLlmUsage } from "../usage";

const log = pino({ name: "strategist" });

// Wrap a tool body so any thrown error becomes `{ error: string }` instead of
// propagating. Models recover gracefully from a returned `error` field (try a
// different slug, retry without the bad filter, etc.) but they tend to spin
// when the AI SDK surfaces a raw "Error: …" from a tool throw. Cheap belt-and-
// braces — applied to every tool below.
async function safeExecute<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ tool: label, err: message }, "strategist tool failed");
    return { error: message };
  }
}

/**
 * A single internal step the strategist took (one of its inner tools fired).
 * The orchestrator forwards these to the chat client so the user sees what's
 * happening during the otherwise-opaque 5–15s strategist call.
 */
export type StrategistSubStep = {
  tool: string;
  args: Record<string, unknown>;
  state: "call" | "result";
  result?: unknown;
};

/**
 * Campaign-level visual identity. Set once per campaign by the Strategist;
 * reused by the Art Director when refining every per-post image brief into a
 * model prompt. Stored on `campaigns.visual_identity` (jsonb).
 *
 * The point: keep image direction CONSISTENT across all posts in a campaign
 * (recurring motifs, color/mood, art style) instead of letting each post
 * drift into a different look. Banned aesthetics are the failure modes the
 * Strategist wants the model to never produce for this brand.
 */
export type VisualIdentity = {
  /** Recurring motifs the brand wants in every campaign image. */
  recurring_motifs: string[];
  /** Lighting/mood/temperature in plain language. */
  color_mood: string;
  /** Art style label ("editorial illustration", "documentary photo"). */
  art_style: string;
  /** Failure modes the model must NOT produce. */
  banned_aesthetics: string[];
  /**
   * User-uploaded third-party brand marks promoted by this campaign
   * (e.g. partner university, sponsor, co-branded program). Each entry is
   * signed and attached as a reference image alongside the workspace brand
   * logo so the model places the real mark instead of fabricating one from
   * the partner's name in the copy.
   *
   * Owned by the upload/delete API routes, not the Strategist. The Strategist
   * tool preserves whatever value is here when it rewrites the rest of the
   * identity. Reuses the existing `visual_identity` JSONB column — see
   * apps/web/app/api/campaigns/[id]/partner-logos/route.ts.
   */
  partner_logos?: PartnerLogo[];
};

/** One uploaded partner logo. Stable id so deletes survive concurrent uploads. */
export type PartnerLogo = {
  id: string;
  /** Storage path under `partner-logos/<workspaceId>/<campaignId>/<uuid>.<ext>` */
  storagePath: string;
  /** Display name shown in the UI ("Arden University"). Used to label the reference. */
  label: string;
  contentType: string;
  addedAt: string;
};

export type StrategistInput = {
  request: string;
  /** Workspace scope; mandatory from PR 4. */
  workspaceId: string;
  campaignId?: string;
  cp: CpClient;
  model?: LlmModel;
  threadRef?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  /**
   * Fires before and after every internal tool the strategist runs. Used by
   * the chat orchestrator to surface live progress (e.g. "Reading brand
   * guidance · 1.2s") under the parent "Strategist" chip. Best-effort: a
   * thrown handler is swallowed so it can't interrupt the agent loop.
   */
  onSubStep?: (event: StrategistSubStep) => void;
};

export async function runStrategist({ request, workspaceId, campaignId, cp, model, threadRef, jobId, workflowRunId, onSubStep }: StrategistInput): Promise<string> {
  // Wrap a tool body with progress emission. Re-uses safeExecute so error
  // mapping behavior is identical for tools that go through this path.
  const tracedExecute = async <T>(
    label: string,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T | { error: string }> => {
    try {
      onSubStep?.({ tool: label, args, state: "call" });
    } catch {
      // a flapping subscriber must not affect the agent loop
    }
    const result = await safeExecute(label, fn);
    try {
      onSubStep?.({ tool: label, args, state: "result", result });
    } catch {
      // ditto
    }
    return result;
  };
  const [baseMemory, visualMemory, marketCtx] = await Promise.all([
    buildBaseMemory({ workspaceId, campaignId }),
    // Strategist plans copy + calendar, not images — pass includeTokens=false
    // to get the brand.visual prose without hex codes / font families.
    buildVisualMemory({ workspaceId, campaignId, includeTokens: false }),
    getWorkspaceMarketContext({ workspaceId }),
  ]);
  const marketBlock = formatMarketBlock(marketCtx);
  const memorySection = [marketBlock, baseMemory, visualMemory]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n---\n\n");

  // Side-effects we want to guarantee land in the DB even if the model gives
  // up before calling the persistence tools. Each tool's execute closure
  // flips the matching flag on success; after generateText we backfill
  // briefMd as a safety net (see the block below the LLM call).
  const persistState = {
    campaignId: campaignId ?? null,
    createdCampaignThisRun: false,
    briefMdSetThisRun: false,
    calendarWrittenThisRun: false,
    visualIdentitySetThisRun: false,
  };

  const strategistBody = await getPrompt("strategist.system", STRATEGIST_PROMPT);
  const systemMessage: CoreMessage = {
    role: "system",
    content: `${strategistBody}\n\n---\n\n# Memory\n\n${memorySection}`,
    // Mark the system block as Anthropic ephemeral-cacheable. Stable across
    // turns within the same workspace, so the model only pays full input
    // cost on the first call within the 5-minute TTL.
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };

  const { text, steps, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(model),
    messages: [systemMessage, { role: "user", content: request }],
    maxSteps: 8,
    tools: {
      read_memory: tool({
        description: "Read a memory file by relative path (e.g. brand/voice.md, learnings/2026-04.md)",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) =>
          tracedExecute("read_memory", { path }, () => loadMemory(path)),
      }),

      read_past_learnings: tool({
        description: "Read all analyst learnings files from the learnings/ directory",
        parameters: z.object({ since: z.string().optional().describe("ISO date string — not used for filtering yet, included for future") }),
        execute: async (args) =>
          tracedExecute("read_past_learnings", args, () => loadMemoryDir("learnings")),
      }),

      list_content: tool({
        description: "List existing content items for a campaign by status. Use to see what's already in flight before scheduling new items.",
        parameters: z.object({
          campaignId: z.string(),
          status: z.enum(["draft", "in_review", "approved", "scheduled", "published", "retracted"]).optional(),
          limit: z.number().int().min(1).max(50).optional().default(20),
        }),
        execute: async ({ campaignId: cid, status, limit }) =>
          tracedExecute(
            "list_content",
            { campaignId: cid, status, limit },
            () => cp.listContent({ campaignId: cid, status, limit }),
          ),
      }),

      find_brand_guidance: tool({
        description:
          "Search brand Markdown files (voice, ICP, positioning) for guidance relevant to " +
          "the campaign or brief you're writing. Use before writing a campaign brief to ensure " +
          "the messaging matches the brand's established voice and target audience.",
        parameters: z.object({
          topic: z.string().describe("The campaign topic, product area, or question to look up"),
          limit: z.number().int().min(1).max(6).optional().default(4),
        }),
        execute: async ({ topic, limit }) =>
          tracedExecute(
            "find_brand_guidance",
            { topic, limit },
            () => findBrandGuidance({ topic, workspaceId, limit }),
          ),
      }),

      create_campaign: tool({
        description: "Create a new campaign in the Control Plane",
        parameters: z.object({
          slug: z.string(),
          name: z.string(),
          phase: z.enum(["buildup", "launch", "post_launch"]).optional(),
          briefMd: z.string().optional(),
        }),
        execute: async (input) =>
          tracedExecute("create_campaign", { slug: input.slug, name: input.name }, async () => {
            const campaign = await cp.createCampaign(input);
            log.info({ campaignId: campaign.id }, "created campaign");
            persistState.campaignId = campaign.id;
            persistState.createdCampaignThisRun = true;
            if (input.briefMd && input.briefMd.trim()) {
              persistState.briefMdSetThisRun = true;
            }
            return campaign;
          }),
      }),

      update_campaign: tool({
        description: "Update an existing campaign's brief or phase",
        parameters: z.object({
          id: z.string(),
          briefMd: z.string().optional(),
          phase: z.enum(["buildup", "launch", "post_launch"]).optional(),
        }),
        execute: async ({ id, ...fields }) =>
          tracedExecute("update_campaign", { id, phase: fields.phase }, async () => {
            const result = await cp.patchCampaign(id, fields);
            log.info({ id }, "updated campaign");
            if (fields.briefMd && fields.briefMd.trim()) {
              persistState.briefMdSetThisRun = true;
              persistState.campaignId = id;
            }
            return result;
          }),
      }),

      set_visual_identity: tool({
        description:
          "Set the campaign's visual identity — recurring motifs, color/mood, art style, " +
          "and banned aesthetics. Call this ONCE per campaign, after the brief is written " +
          "and before scheduling content. Every post's image will be art-directed against " +
          "this identity to keep the campaign visually consistent. " +
          "Be specific and concrete: 'isometric dashboard screenshots' beats 'modern UI'. " +
          "Banned aesthetics should name the AI-slop failure modes you want avoided " +
          "('no AI faces', 'no generic crypto coins', 'no rainbow gradients').",
        parameters: z.object({
          campaignId: z.string(),
          recurring_motifs: z
            .array(z.string())
            .min(1)
            .describe(
              "Motifs that should appear across all campaign images (e.g. 'editorial line illustration of a single product flow', 'warm desk-top photography with one device')",
            ),
          color_mood: z
            .string()
            .min(4)
            .describe("Lighting + mood + palette in plain language"),
          art_style: z
            .string()
            .min(4)
            .describe(
              "One concrete style label ('editorial illustration, not stock photo', 'documentary photo, natural light')",
            ),
          banned_aesthetics: z
            .array(z.string())
            .describe("Failure modes the model must NOT produce"),
        }),
        execute: async ({ campaignId: cid, ...identity }) =>
          tracedExecute("set_visual_identity", { campaignId: cid }, async () => {
            // Preserve user-owned partner_logos. The Strategist only owns the
            // four design fields; partner logos are uploaded separately and
            // would be wiped by a naive full-replacement write.
            let preservedPartnerLogos: VisualIdentity["partner_logos"];
            try {
              const current = await cp.getCampaign(cid);
              const existing = (current.visualIdentity ?? null) as
                | VisualIdentity
                | null;
              preservedPartnerLogos = existing?.partner_logos;
            } catch (err) {
              log.warn(
                { cid, err: (err as Error).message },
                "could not read existing visual identity — partner_logos may be lost if any were attached",
              );
            }
            const merged: VisualIdentity = preservedPartnerLogos
              ? { ...identity, partner_logos: preservedPartnerLogos }
              : identity;
            await cp.patchCampaign(cid, { visualIdentity: merged });
            log.info({ cid }, "visual identity set");
            persistState.visualIdentitySetThisRun = true;
            persistState.campaignId = cid;
            return { campaignId: cid, saved: true, identity: merged };
          }),
      }),

      find_similar_content: tool({
        description:
          "Retrieve semantically similar approved content items from the knowledge base. " +
          "Call this BEFORE drafting any new content to ground the response in past wins. " +
          "Cite the results in a <rationale> block in your response.",
        parameters: z.object({
          topic: z.string().describe("Short description of the topic / angle you're exploring"),
          channel: z.enum(CHANNELS).optional().describe("Filter by a specific channel"),
          minCTR: z.number().min(0).max(1).optional().describe("Minimum click-through rate (0–1)"),
          minEngagement: z.number().min(0).max(1).optional().describe("Minimum engagement rate (0–1)"),
          limit: z.number().int().min(1).max(10).optional().default(5),
        }),
        execute: async (opts) =>
          tracedExecute(
            "find_similar_content",
            { topic: opts.topic, channel: opts.channel },
            async () => {
              const results = await findSimilarContent(opts);
              log.info({ topic: opts.topic, count: results.length }, "similar content retrieved");
              return results;
            },
          ),
      }),

      write_calendar: tool({
        description: "Persist a content calendar to a campaign's calendarJson field",
        parameters: z.object({
          campaignId: z.string(),
          items: z.array(
            z.object({
              title: z.string(),
              type: z.enum([
                "blog",
                "linkedin",
                "x_thread",
                "x_post",
                "email",
                "instagram",
                "facebook",
              ]),
              stage: z.enum(["pull", "explain", "reinforce", "push"]),
              phase: z.enum(["buildup", "launch", "post_launch"]),
              scheduledFor: z.string().optional().describe("ISO date string"),
            }),
          ),
        }),
        execute: async ({ campaignId: cid, items }) =>
          tracedExecute(
            "write_calendar",
            { campaignId: cid, count: items.length },
            async () => {
              log.info({ cid, count: items.length }, "writing calendar");
              await cp.patchCampaign(cid, { calendarJson: items });
              persistState.calendarWrittenThisRun = true;
              persistState.campaignId = cid;
              return { campaignId: cid, itemCount: items.length, saved: true };
            },
          ),
      }),
    },
  });

  log.info({ steps: steps.length }, "strategist finished");

  // Safety net: a campaign was created this run but the model never persisted
  // a brief. The text return is about to be handed back to the orchestrator,
  // which may then crash, time out, or get truncated — and the plan would
  // be lost. Write the model's final text to briefMd so the campaign row
  // owns the work even if everything downstream fails. We only touch briefMd
  // when this run created the campaign, so existing briefs are never
  // clobbered by a no-op turn.
  if (
    persistState.createdCampaignThisRun &&
    !persistState.briefMdSetThisRun &&
    persistState.campaignId &&
    text.trim()
  ) {
    try {
      await cp.patchCampaign(persistState.campaignId, { briefMd: text });
      log.info(
        { cid: persistState.campaignId },
        "safety-net briefMd write (model did not call update_campaign with briefMd)",
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message, cid: persistState.campaignId },
        "safety-net briefMd write failed",
      );
    }
  }
  if (
    persistState.createdCampaignThisRun &&
    !persistState.calendarWrittenThisRun
  ) {
    log.warn(
      { cid: persistState.campaignId },
      "strategist created a campaign but never called write_calendar — calendar missing on this run",
    );
  }

  await recordLlmUsage({
    agent: "strategist",
    workspaceId,
    model,
    threadRef,
    jobId,
    workflowRunId,
    usage,
    providerMetadata: experimental_providerMetadata,
  });
  return text;
}
