/**
 * learning-synthesis workflow.
 *
 * Closes the agent_feedback → KB loop:
 *   1. Aggregate the last N days of agent_feedback (rejection reasons,
 *      common-mistake embeddings, channel splits).
 *   2. Pass the raw signal to an LLM that distils 3-7 actionable lessons.
 *   3. Write the lessons back to the KB as a `playbook` collection doc
 *      so the content sub-agent picks them up via findCommonMistakes /
 *      kb_search on its next run.
 *
 * Wired to /api/cron/learning-synthesis for weekly runs.
 */
import { generateText } from "ai";
import { ensureCollection, upsertDocument, chunkAndEmbed } from "@marketing/agents/kb";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import { aggregateLearningSignal, type LearningSummary } from "@/lib/learning/aggregate";
import { LEGACY_WORKSPACE_ID } from "@/lib/billing";

export type LearningSynthesisInput = {
  windowDays?: number;
  /** Optional collection slug override; default 'learning-loop'. */
  collectionSlug?: string;
  /** Workspace scope; required from PR 4. Defaults to legacy when omitted. */
  workspaceId?: string;
};

export type LearningSynthesisOutput = {
  documentId: string | null;
  documentSlug: string;
  themes: number;
  decisionsSeen: number;
  approvalRate: number;
  reason: string;
};

export async function learningSynthesisWorkflow(
  input: LearningSynthesisInput,
): Promise<LearningSynthesisOutput> {
  "use workflow";
  const summary = await aggregateStep(input);
  if (summary.totals.decisions < 5) {
    return {
      documentId: null,
      documentSlug: "",
      themes: 0,
      decisionsSeen: summary.totals.decisions,
      approvalRate: summary.totals.approvalRate,
      reason: "not_enough_data",
    };
  }
  const workspaceId = input.workspaceId ?? LEGACY_WORKSPACE_ID;
  const themes = await synthesiseStep({ summary, workspaceId });
  if (themes.length === 0) {
    return {
      documentId: null,
      documentSlug: "",
      themes: 0,
      decisionsSeen: summary.totals.decisions,
      approvalRate: summary.totals.approvalRate,
      reason: "llm_returned_no_themes",
    };
  }
  const result = await persistStep({
    themes,
    summary,
    collectionSlug: input.collectionSlug ?? "learning-loop",
    windowDays: input.windowDays ?? 30,
    workspaceId,
  });
  return {
    documentId: result.documentId,
    documentSlug: result.documentSlug,
    themes: themes.length,
    decisionsSeen: summary.totals.decisions,
    approvalRate: summary.totals.approvalRate,
    reason: "ok",
  };
}

// ============================================================
// Steps
// ============================================================

async function aggregateStep(
  input: LearningSynthesisInput,
): Promise<LearningSummary> {
  "use step";
  return aggregateLearningSignal({
    windowDays: input.windowDays ?? 30,
    limit: 30,
  });
}

type Theme = {
  title: string;
  pattern: string;
  prescription: string;
  examples: string[];
};

async function synthesiseStep(args: {
  summary: LearningSummary;
  workspaceId: string;
}): Promise<Theme[]> {
  "use step";
  const { summary } = args;

  const prompt = buildSynthesisPrompt(summary);
  const { text, usage, experimental_providerMetadata } = await generateText({
    model: getLanguageModel(),
    system: `You distil patterns from a queue of rejected/edited content.
Output strict JSON: an array of 3-7 themes, each with {title, pattern,
prescription, examples}. No markdown fence, no commentary.

  - title: 3-6 words naming the theme
  - pattern: one sentence describing what reviewers consistently flag
  - prescription: one sentence of guidance the next draft should follow
  - examples: 1-3 short quoted reviewer reasons that exemplify the theme`,
    prompt,
  });

  await recordLlmUsage({
    agent: "learning-synthesis",
    workspaceId: args.workspaceId,
    usage,
    providerMetadata: experimental_providerMetadata,
  });

  try {
    const parsed = JSON.parse(stripFence(text));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is Theme =>
          t &&
          typeof t.title === "string" &&
          typeof t.pattern === "string" &&
          typeof t.prescription === "string",
      )
      .map((t) => ({
        title: t.title,
        pattern: t.pattern,
        prescription: t.prescription,
        examples: Array.isArray(t.examples)
          ? t.examples.filter((e: unknown): e is string => typeof e === "string").slice(0, 3)
          : [],
      }))
      .slice(0, 7);
  } catch {
    return [];
  }
}

async function persistStep(args: {
  themes: Theme[];
  summary: LearningSummary;
  collectionSlug: string;
  windowDays: number;
  workspaceId: string;
}): Promise<{ documentId: string; documentSlug: string }> {
  "use step";
  const collectionId = await ensureCollection({
    workspaceId: args.workspaceId,
    slug: args.collectionSlug,
    name: "Learning Loop",
    kind: "playbook",
    scope: "global",
    campaignId: null,
    description:
      "Synthesised lessons from agent_feedback. Auto-generated; humans can override entries by editing the doc body.",
  });

  const docSlug = `lessons-${new Date().toISOString().slice(0, 10)}`;
  const body = buildPlaybookBody(args.themes, args.summary, args.windowDays);

  const doc = await upsertDocument({
    workspaceId: args.workspaceId,
    collectionId,
    slug: docSlug,
    title: `Learning loop lessons — ${args.windowDays}d window`,
    source: "agent",
    bodyMd: body,
    metadata: {
      generatedAt: new Date().toISOString(),
      windowDays: args.windowDays,
      decisionsSeen: args.summary.totals.decisions,
      approvalRate: args.summary.totals.approvalRate,
    },
    status: "active",
    bumpVersion: true,
  });
  await chunkAndEmbed(doc.id);
  return { documentId: doc.id, documentSlug: doc.slug };
}

// ============================================================
// Helpers (pure)
// ============================================================

function buildSynthesisPrompt(summary: LearningSummary): string {
  const totals = summary.totals;
  const reasons = summary.topReasons
    .map(
      (r, i) =>
        `[${i + 1}] (${r.decision}, n=${r.count}) ${r.reason.slice(0, 240)}`,
    )
    .join("\n");

  const recent = summary.recentRejections
    .map(
      (r, i) =>
        `(${i + 1}) "${r.contentTitle}" → ${r.decision}: ${r.reason ?? "(no reason)"}`.slice(
          0,
          240,
        ),
    )
    .join("\n");

  const channels = summary.byChannel
    .map(
      (c) =>
        `${c.channel}: approval ${(c.approvalRate * 100).toFixed(0)}% (${c.approved}/${c.approved + c.rejected + c.changes})`,
    )
    .join(" · ");

  return `# Decision totals
Approved: ${totals.approved}
Changes requested: ${totals.changes_requested}
Rejected: ${totals.rejected}
Approval rate: ${(totals.approvalRate * 100).toFixed(1)}%

# Edit distance (approved drafts)
count=${summary.editDistance.count} avg=${summary.editDistance.avg?.toFixed(0) ?? "n/a"} p50=${summary.editDistance.p50?.toFixed(0) ?? "n/a"} p90=${summary.editDistance.p90?.toFixed(0) ?? "n/a"}

# Per-channel approval rates
${channels || "(none)"}

# Top rejection / change reasons
${reasons || "(none)"}

# Recent rejections (last ${summary.recentRejections.length})
${recent || "(none)"}

Identify 3-7 themes. Output JSON only.`;
}

function buildPlaybookBody(
  themes: Theme[],
  summary: LearningSummary,
  windowDays: number,
): string {
  const lines: string[] = [];
  lines.push(`# Learning loop lessons (${windowDays}d window)`);
  lines.push("");
  lines.push(
    `**Decisions:** ${summary.totals.decisions} · approval rate ${(summary.totals.approvalRate * 100).toFixed(1)}% · rejected ${summary.totals.rejected} · changes requested ${summary.totals.changes_requested}`,
  );
  if (summary.editDistance.avg != null) {
    lines.push(
      `**Edit distance (approved drafts):** avg ${summary.editDistance.avg.toFixed(0)} chars · p50 ${summary.editDistance.p50?.toFixed(0) ?? "n/a"} · p90 ${summary.editDistance.p90?.toFixed(0) ?? "n/a"}`,
    );
  }
  lines.push("");
  themes.forEach((t, i) => {
    lines.push(`## ${i + 1}. ${t.title}`);
    lines.push("");
    lines.push(`**Pattern.** ${t.pattern}`);
    lines.push("");
    lines.push(`**Prescription.** ${t.prescription}`);
    if (t.examples.length > 0) {
      lines.push("");
      lines.push("**Examples:**");
      for (const ex of t.examples) {
        lines.push(`- "${ex}"`);
      }
    }
    lines.push("");
  });
  lines.push("---");
  lines.push("");
  lines.push(
    "_Auto-generated by the learning-synthesis workflow. Edit the body to override; the next synthesis run will create a fresh document under a new slug rather than overwriting human edits._",
  );
  return lines.join("\n");
}

function stripFence(text: string): string {
  const m = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  return m && m[1] ? m[1] : text.trim();
}
