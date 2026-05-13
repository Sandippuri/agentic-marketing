/**
 * Background learning loop for the test chat. After each assistant reply is
 * finalised, this scans the last few turns with a small model and persists any
 * durable user-stated preference / brand rule / recurring fact into the KB as
 * a `playbook` document so future chats (and sub-agents via kb_search) can use
 * it. Fire-and-forget; failures are logged but never bubble up to the user.
 *
 * Scope policy: every captured insight is classified by the extractor as
 *   - "team"     → applies to the whole marketing org (brand voice, ICP, …)
 *   - "personal" → applies only to the user who said it (their preference)
 * Both kinds live in the same `chat-insights` collection but personal ones
 * stamp metadata.userId so the orchestrator prompt can ignore other users'
 * personal rules at retrieval time.
 *
 * Env:
 *   - CHAT_LEARNING_MODEL  — override the extractor model (default haiku 4.5)
 *   - OPENAI_API_KEY       — required for chunk embedding; if missing the
 *     extractor bails early with a clear warning rather than writing an
 *     unsearchable orphan doc.
 */

import { generateObject } from "ai";
import { z } from "zod";
import pino from "pino";
import {
  ensureCollection,
  upsertDocument,
  chunkAndEmbed,
  kbSearch,
} from "@marketing/agents/kb";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { resolveLlmModel } from "@marketing/shared-types";

const log = pino({ name: "chat-learning" });

const DEFAULT_EXTRACTOR_MODEL = "claude-haiku-4-5-20251001";
const COLLECTION = {
  slug: "chat-insights",
  name: "Chat Insights",
  kind: "playbook" as const,
};

const InsightSchema = z.object({
  shouldSave: z
    .boolean()
    .describe("True only if the user stated a durable, reusable rule/preference/fact."),
  scope: z
    .enum(["team", "personal"])
    .optional()
    .describe(
      "team = whole marketing org (brand voice, ICP, process). personal = only this user (their workflow preference).",
    ),
  title: z.string().optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  body_md: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

type LearnInput = {
  threadRef: string;
  userId: string;
  userMessage: string;
  assistantMessage: string;
  history: Array<{ role: string; content: string }>;
};

let warnedMissingEmbedKey = false;

export function learnFromConversation(input: LearnInput): void {
  // Fire-and-forget — never block the chat reply path.
  void runExtractor(input).catch((err) => {
    log.warn(
      { err: (err as Error).message, threadRef: input.threadRef },
      "chat-learning extractor failed",
    );
  });
}

async function runExtractor(input: LearnInput): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    if (!warnedMissingEmbedKey) {
      warnedMissingEmbedKey = true;
      log.warn(
        "OPENAI_API_KEY not set — chat-learning is disabled (cannot embed insights for retrieval)",
      );
    }
    return;
  }

  const model = resolveExtractorModel();
  const transcript = renderTranscript(input);
  const { object } = await generateObject({
    model: getLanguageModel(model),
    schema: InsightSchema,
    system: EXTRACTOR_SYSTEM,
    prompt: transcript,
  });

  if (!object.shouldSave || !object.title || !object.slug || !object.body_md) {
    return;
  }
  const scope = object.scope ?? "team";

  // De-dup: if the KB already has a near-identical insight for this scope, skip.
  // For personal scope, only de-dup against the same user's personal insights so
  // two users can independently capture the same-sounding rule.
  const existing = await kbSearch({
    query: object.title,
    collectionKinds: ["playbook"],
    k: 5,
    minSimilarity: 0.9,
  }).catch(() => []);
  const duplicate = existing.find((hit) => {
    const meta = (hit.metadata ?? {}) as Record<string, unknown>;
    const hitScope = meta.scope === "personal" ? "personal" : "team";
    if (hitScope !== scope) return false;
    if (scope === "personal" && meta.userId !== input.userId) return false;
    return true;
  });
  if (duplicate) {
    log.info(
      { threadRef: input.threadRef, slug: object.slug, hit: duplicate.documentTitle, scope },
      "skipping duplicate insight",
    );
    return;
  }

  const collectionId = await ensureCollection({
    slug: COLLECTION.slug,
    name: COLLECTION.name,
    kind: COLLECTION.kind,
    scope: "global",
    campaignId: null,
  });

  // Personal slugs are namespaced by user so two users can hold the same slug
  // without colliding inside one global collection.
  const persistedSlug =
    scope === "personal" ? `${object.slug}-u-${shortHash(input.userId)}` : object.slug;

  const doc = await upsertDocument({
    collectionId,
    slug: persistedSlug,
    title: object.title,
    source: "agent",
    bodyMd: object.body_md,
    metadata: {
      capturedBy: input.userId,
      userId: input.userId,
      threadRef: input.threadRef,
      tags: object.tags ?? [],
      scope,
      origin: "chat-auto-extract",
    },
    status: "active",
    createdBy: input.userId,
    bumpVersion: true,
  });
  await chunkAndEmbed(doc.id);
  log.info(
    { threadRef: input.threadRef, docId: doc.id, slug: persistedSlug, scope },
    "chat insight captured",
  );
}

function resolveExtractorModel() {
  const raw = process.env.CHAT_LEARNING_MODEL;
  if (!raw) return DEFAULT_EXTRACTOR_MODEL;
  try {
    return resolveLlmModel(raw);
  } catch {
    log.warn(
      { raw },
      "CHAT_LEARNING_MODEL is not a known LLM id; falling back to default",
    );
    return DEFAULT_EXTRACTOR_MODEL;
  }
}

function shortHash(input: string): string {
  // Cheap, stable, non-crypto. Just enough to keep slugs unique per user.
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

function renderTranscript(input: LearnInput): string {
  const recent = input.history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  return [
    "Conversation so far:",
    recent,
    "",
    `Latest user message:\n${input.userMessage}`,
    "",
    `Latest assistant reply:\n${input.assistantMessage}`,
  ].join("\n");
}

const EXTRACTOR_SYSTEM = `You are a memory extractor for a marketing chat assistant.

Your job: read the last few turns of a chat and decide whether the user has stated something durable and reusable that should be remembered across future sessions.

SAVE (set shouldSave=true) when the user states any of:
- a brand voice rule ("we never use exclamation marks", "always include a customer quote")
- an ICP / persona detail ("our buyers are mid-market FinTech CISOs")
- a recurring preference ("LinkedIn posts should be under 150 words", "always tag @CEO")
- a fact about their product, company, channels, or process that is not already obvious
- an explicit "remember that …" / "from now on …" / "always …" / "never …"

DO NOT save:
- one-off task instructions ("write me a post about X today")
- transient context ("the campaign is Q2 launch")
- the assistant's own suggestions unless the user confirmed them as a rule
- restatements of common-sense marketing advice
- anything ambiguous

CLASSIFY scope:
- "team"     — applies to the whole marketing org. Brand voice, ICP/persona,
   product facts, process rules. Language is usually plural / "we" / "our".
- "personal" — applies only to the speaker. Their own workflow preference,
   their own communication style. Language is usually singular / "I" / "me".
If unsure, prefer "team".

When shouldSave=true, also produce:
- scope: "team" | "personal"
- title: short human title (under 60 chars)
- slug: kebab-case unique slug (lowercase, hyphens only). DO NOT include the
   user id — the system namespaces personal-scope slugs automatically.
- body_md: Markdown body structured as:
    Lead with the rule/fact in one sentence.
    **Why:** the reason the user gave (if any).
    **How to apply:** when this rule kicks in.
- tags: optional array of short topic tags

When shouldSave=false, leave the other fields empty.

Bias toward NOT saving. Only save when the signal is unambiguous.`;
