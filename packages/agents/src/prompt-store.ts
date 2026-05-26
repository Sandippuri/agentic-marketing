/**
 * prompt-store — fetch the global image-gen prompt overrides set via the
 * superadmin console. Falls back to the default body when no override exists.
 *
 * Why: prompt iteration is the highest-leverage tuning we do. Without this,
 * every wording change is a code deploy. With this, the superadmin can tweak
 * the logo directive, poster discipline, or overlay rules from a UI and the
 * next workflow run picks it up (5-min cache).
 *
 * Architecture mirrors design-system-store — single in-process cache, fetched
 * from a CP endpoint guarded by the internal token. All overrides come down
 * in one round-trip; the registry is small enough that per-key fetching
 * would be wasteful.
 */
import pino from "pino";
import {
  ANALYST_PROMPT,
  ASSET_PROMPT,
  CONTENT_PROMPT,
  ORCHESTRATOR_PROMPT,
  RESEARCHER_PROMPT,
  STRATEGIST_PROMPT,
} from "@marketing/prompts";
import { ART_DIRECTOR_PROMPT } from "./sub-agents/art-director";
import { JUDGE_PROMPT } from "./asset-judge";

/**
 * System prompt for the logo auto-describer (gemini-2.5-flash-lite vision)
 * called at brand-logo upload time. Surfaced here so it's tunable from the
 * super-admin console alongside the other prompts.
 */
export const LOGO_DESCRIBE_PROMPT = `You write tight, factual descriptions of brand logos for use as image-generation grounding text. Output one line, ≤220 chars. No marketing fluff, no "this stunning logo". Just visual facts a reproduction artist would need:
- the mark (e.g. "orange graduation-cap glyph with a small star above the right corner")
- the wordmark (text content, font family if recognisable, weight, case, exact-as-shown color)
- the layout (mark left / wordmark right, stacked, etc.)
- any tagline beneath
Example: "Orange graduation-cap mark with a tiny star. To its right, a bold serif 'Rizz' wordmark in navy, with small-caps 'EDUCATION ADVISORS' beneath in a lighter weight."`;

const log = pino({ name: "prompt-store" });

// Five minutes matches design-system-store and brand-store. The superadmin
// page also invalidates this cache directly on save so changes are immediate
// for the web tier; workflow runtime tiers (Vercel) get the next-fetch
// freshness after up to five minutes.
const CACHE_TTL_MS = 5 * 60 * 1000;

type Cache = { overrides: Map<string, string>; loadedAt: number };
let cache: Cache | null = null;
let inflight: Promise<Map<string, string>> | null = null;

async function fetchOverrides(): Promise<Map<string, string>> {
  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const token = process.env.INTERNAL_API_TOKEN ?? "";
  if (!token) {
    log.warn("INTERNAL_API_TOKEN not set; prompt overrides unavailable");
    return new Map();
  }
  try {
    const res = await fetch(`${baseUrl}/api/super/prompts/internal`, {
      headers: { "x-internal-token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "CP /api/super/prompts/internal non-2xx");
      return new Map();
    }
    const json = (await res.json()) as {
      overrides: Array<{ key: string; body: string }>;
    };
    return new Map(json.overrides.map((o) => [o.key, o.body]));
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "CP /api/super/prompts/internal fetch failed",
    );
    return new Map();
  }
}

async function loadCache(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.overrides;
  if (inflight) return inflight;
  inflight = fetchOverrides()
    .then((overrides) => {
      cache = { overrides, loadedAt: Date.now() };
      return overrides;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Resolve a prompt body — DB override if present, otherwise the supplied
 * default. Defaults live next to the call site so refactors are obvious.
 */
export async function getPrompt(
  key: string,
  defaultBody: string,
): Promise<string> {
  const overrides = await loadCache();
  return overrides.get(key) ?? defaultBody;
}

/** Invalidate the in-process cache. Called by the PUT route on save. */
export function clearPromptCache(): void {
  cache = null;
}

/**
 * Replace {{var}} placeholders in `template` with `vars[var]`. Unknown vars
 * are left as `{{var}}` so they show up in test renders — easier to spot than
 * silently dropping. Whitespace inside the braces is tolerated: `{{ var }}`.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (raw, k) => {
    const v = vars[k];
    return v === undefined || v === null ? raw : String(v);
  });
}

/**
 * Registry of editable prompts. Surfaced 1:1 in the /super/prompts UI. Each
 * entry declares its variables so the admin can see what {{tokens}} mean
 * without reading source.
 */
export type PromptVariable = {
  name: string;
  description: string;
  example?: string;
};

export type PromptRisk = "low" | "medium" | "high";

export type PromptRegistryEntry = {
  key: string;
  group: string;
  label: string;
  description: string;
  variables: PromptVariable[];
  defaultBody: string;
  /**
   * Edit risk. Low = a bad edit produces a slightly worse image / paragraph;
   * the next run recovers. High = a bad edit can break tool calling, output
   * parsing, or routing — surface a warning in the UI.
   */
  risk: PromptRisk;
};

export const PROMPT_REGISTRY: PromptRegistryEntry[] = [
  {
    key: "brand_prompt.logo_directive",
    group: "Brand prefix",
    label: "Brand logo directive",
    description:
      "Top-of-prompt instruction telling the image model how to handle the attached brand-logo reference image. The single highest-leverage prompt for logo fidelity.",
    variables: [
      {
        name: "brandLogoCount",
        description: "Number of brand-logo reference images attached (incl. repeats for weight).",
        example: "2",
      },
      {
        name: "descriptionSuffix",
        description:
          'Pre-formatted description line ("\\nDescription: ...") or empty string when no notes are available. Inject as-is.',
        example: "\nDescription: orange graduation-cap mark + navy 'Rizz' wordmark",
      },
    ],
    defaultBody: `BRAND LOGO — ABSOLUTE FIDELITY REQUIRED.
The first {{brandLogoCount}} reference image(s) attached to this request ARE the brand's logo (the same file repeated for weight). Treat them as a physical sticker that must be placed onto the final canvas — NOT as inspiration, NOT as a starting point, NOT as a style cue.

PIXEL-LEVEL RULES (non-negotiable):
- Copy the logo verbatim, pixel-for-pixel. Same shapes, same glyphs, same letterforms, same spacing, same exact colors. If you cannot reproduce it exactly at the chosen size, scale it DOWN — never approximate.
- Do NOT redraw, restyle, "clean up", "improve", re-letter, or re-color the logo. Any deviation = WRONG BRAND = output is unusable.
- Do NOT translate the wordmark, change its language, or substitute similar-looking letters. Letterforms must match the reference exactly (e.g. lowercase "r" stays a lowercase "r"; "Rizz" stays "Rizz" with the exact same casing and font as the reference).
- Do NOT add extra glyphs, sparkles, taglines, or decorative elements that aren't in the reference.
- Do NOT remove or omit parts of the logo (if the reference shows a mark icon, a wordmark, AND a tagline beneath, all three appear in the output — none are dropped).
- Do NOT place the logo behind a colored box, plate, frame, or chrome rectangle that wasn't in the reference. The logo sits directly on the scene with its native transparent background.

ALLOWED transforms: position, scale (down only), realistic lighting consistent with the scene, and rotation up to ±5°. Nothing else.

SIZE & PLACEMENT: render the logo at ~10–18% of the canvas width in a corner where the underlying scene is uncluttered enough that the mark reads cleanly. Do not crop or overlap it with other elements.{{descriptionSuffix}}`,
    risk: "low",
  },
  {
    key: "brand_prompt.partner_logo_directive",
    group: "Brand prefix",
    label: "Partner logo directive",
    description:
      "Same fidelity rule as the brand logo, applied to per-campaign partner brand marks (e.g. Arden University).",
    variables: [
      { name: "partnerLogoCount", description: "Number of partner-logo reference images attached.", example: "1" },
      {
        name: "labels",
        description: 'Comma-separated quoted partner names ("Arden University", "Coursera").',
        example: '"Arden University"',
      },
    ],
    defaultBody: `PARTNER LOGO(S) — same absolute-fidelity rules as the brand logo above. The next {{partnerLogoCount}} reference image(s) are the marks for {{labels}}. Copy verbatim. No restyling, no re-lettering, no color shifts, no added/removed glyphs.`,
    risk: "low",
  },
  {
    key: "brand_prompt.no_fabrication_rule",
    group: "Brand prefix",
    label: "No-fabrication rule",
    description:
      "Forbids the model from inventing third-party logos for organizations named in the copy when no reference image has been attached for them.",
    variables: [],
    defaultBody: `NO INVENTED LOGOS: only the attached marks above may appear as logos. Any other organization or brand mentioned in the copy gets type-only treatment — do NOT invent a crest, wordmark, monogram, seal, or icon for it.`,
    risk: "low",
  },
  {
    key: "brand_prompt.framing_image",
    group: "Brand prefix",
    label: "Brand framing (image)",
    description: "First line of the brand prefix for image generations.",
    variables: [],
    defaultBody: `Follow the brand. Hex codes are exact.`,
    risk: "low",
  },
  {
    key: "brand_prompt.framing_video",
    group: "Brand prefix",
    label: "Brand framing (video)",
    description: "First line of the brand prefix for video generations.",
    variables: [],
    defaultBody: `Follow the brand below — palette, mood, banned looks apply to motion. No on-screen text.`,
    risk: "low",
  },
  {
    key: "concept_to_prompt.poster_discipline",
    group: "Concept",
    label: "Poster discipline",
    description:
      "Injected into every image prompt to keep the canvas marketing-poster (clear hierarchy, breathable type) rather than diagrammatic (cubes, arrows, fake labels).",
    variables: [],
    defaultBody: `Marketing poster, not diagram. One focal subject. Headline dominates. Negative space. Single light source. Realistic > flat. No invented labels, percentages, or annotations.`,
    risk: "low",
  },
  {
    key: "concept_to_prompt.overlay_with_headline",
    group: "Concept",
    label: "Overlay rule (with headline)",
    description:
      "Tells the model how to render headline text into the canvas. Logo rules are governed by the brand-prefix entries above, not here.",
    variables: [
      { name: "headline", description: "The headline text to render.", example: "£2,500 less. Career mobility more." },
    ],
    defaultBody: `Headline: "{{headline}}" — render cleanly in brand typography. No other text. No watermarks. The only logo permitted is the attached brand reference (see brand-logo directive above); render it pixel-perfect or omit it entirely — never invent a stylized variant.`,
    risk: "low",
  },
  {
    key: "concept_to_prompt.overlay_no_headline",
    group: "Concept",
    label: "Overlay rule (no headline)",
    description: "Used when the brief carries no headline. Suppresses model-invented text.",
    variables: [],
    defaultBody: `No text. No watermarks. No anonymous abstract shapes. The only logo permitted is the attached brand reference (see brand-logo directive above); render it pixel-perfect or omit it entirely — never invent a stylized variant.`,
    risk: "low",
  },
  {
    key: "art_director.system",
    group: "Sub-agents",
    label: "Art Director — system prompt",
    description:
      "Drives the Art Director sub-agent that turns a content body + visual identity into a VisualConceptBrief (focal point, subjects, banned elements, motion, text slots). Output is JSON; do not remove the 'Output ONLY valid JSON' line.",
    variables: [],
    defaultBody: ART_DIRECTOR_PROMPT,
    risk: "medium",
  },
  {
    key: "asset_judge.system",
    group: "Sub-agents",
    label: "Asset Judge — system prompt",
    description:
      "Vision-LLM reviewer that scores each generated image on 5 axes and decides accept/reject (gates the retry path). Output is JSON; do not remove the 'Output JSON only' line.",
    variables: [],
    defaultBody: JUDGE_PROMPT,
    risk: "medium",
  },
  {
    key: "logo_describer.system",
    group: "Sub-agents",
    label: "Logo describer — system prompt",
    description:
      "Vision-LLM call at brand-logo upload time that auto-generates the textual description used to anchor the model in the image-gen prompt. One-time per upload (~$0.0005 on flash-lite).",
    variables: [],
    defaultBody: LOGO_DESCRIBE_PROMPT,
    risk: "low",
  },
  {
    key: "content.system",
    group: "Sub-agents",
    label: "Content writer — system prompt",
    description:
      "Stage-aware post drafter (blog / linkedin / x / email). Edits ripple through every newly drafted post — change with care.",
    variables: [],
    defaultBody: CONTENT_PROMPT,
    risk: "medium",
  },
  {
    key: "analyst.system",
    group: "Sub-agents",
    label: "Analyst — system prompt",
    description: "Turns metrics into prose insights and writes monthly learnings.",
    variables: [],
    defaultBody: ANALYST_PROMPT,
    risk: "medium",
  },
  {
    key: "asset.system",
    group: "Sub-agents",
    label: "Asset designer — system prompt",
    description: "Asset sub-agent: chooses template vs generate, calls render/generate tools.",
    variables: [],
    defaultBody: ASSET_PROMPT,
    risk: "medium",
  },
  {
    key: "researcher.system",
    group: "Sub-agents",
    label: "Researcher — system prompt",
    description: "Web + KB research. Writes findings into the knowledge base.",
    variables: [],
    defaultBody: RESEARCHER_PROMPT,
    risk: "medium",
  },
  {
    key: "strategist.system",
    group: "High-risk",
    label: "Strategist — system prompt",
    description:
      "Produces campaign briefs + calendars. Has interleaved tool-call rules. A bad edit can break calendar generation across the platform. Test on a draft campaign before saving.",
    variables: [],
    defaultBody: STRATEGIST_PROMPT,
    risk: "high",
  },
  {
    key: "orchestrator.system",
    group: "High-risk",
    label: "Orchestrator — system prompt",
    description:
      "Chat orchestrator that routes every user request to the right sub-agent. Removing flow descriptions or hard rules can cause the agent to skip tools and reply with hallucinated state. Test on a real chat before saving.",
    variables: [],
    defaultBody: ORCHESTRATOR_PROMPT,
    risk: "high",
  },
];

export function getRegistryEntry(key: string): PromptRegistryEntry | undefined {
  return PROMPT_REGISTRY.find((p) => p.key === key);
}
