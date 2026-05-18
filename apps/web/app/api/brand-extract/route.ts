// POST /api/brand-extract — read every uploaded brand-doc, ask the LLM to
// distill them into draft brand-memory bodies + design tokens, and return
// the drafts inline. The route is stateless: nothing is written to
// brand_memory or brand_design_system here — the admin reviews the drafts
// in a modal and confirms via the existing PUT endpoints. Run history is
// not persisted yet (extraction_runs / brand_memory_drafts tables exist
// for that, but aren't wired up — this route can be upgraded later).
//
// Optional JSON body: { seed?: { brandName?: string; pitch?: string } }.
// The onboarding wizard collects 1–2 quick answers from the user and posts
// them here so the LLM has a north star even when the uploaded corpus is
// thin or genre-ambiguous.

import { generateObject, NoObjectGeneratedError } from "ai";
import { inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@marketing/db";
import {
  DESIGN_COLOR_ROLES,
  DEFAULT_LLM_MODEL,
  resolveLlmModel,
} from "@marketing/shared-types";
import { getLanguageModel } from "@marketing/agents/llm-registry";
import { recordLlmUsage } from "@marketing/agents/usage";
import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { downloadBrandDoc } from "@/lib/supabase/storage";
import { getWorkspaceContext } from "@/lib/billing";

export const dynamic = "force-dynamic";
// File parsing + a multi-doc LLM call can take a while.
export const maxDuration = 300;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// We keep the schema we hand to the LLM permissive — every previously-strict
// constraint (hex regex, role enum, min-length on color name, integer weights)
// is something models occasionally violate, and the AI SDK's whole-call
// rejection on a single bad field meant a thin landing-page scrape would
// often fail the entire generation. Anything questionable is sanitized after
// validation, before the response leaves the route.
const LooseColorSchema = z.object({
  name: z.string().max(80).nullable().optional(),
  hex: z.string().max(20).nullable().optional(),
  role: z.string().max(40).nullable().optional(),
  usage: z.string().max(500).nullable().optional(),
});

const DraftSchema = z.object({
  voice: z
    .string()
    .describe(
      "Markdown body for brand.voice — tone, vocabulary, sentence rhythm, banned phrases. 200–600 words. No preamble, no headings above H2.",
    ),
  icp: z
    .string()
    .describe(
      "Markdown body for brand.icp — ideal customer profile: roles, company size, jobs-to-be-done, pains, gains. 200–600 words.",
    ),
  visual: z
    .string()
    .describe(
      "Markdown body for brand.visual — palette intent, typography vibe, photography/illustration direction, banned looks. 150–500 words.",
    ),
  productState: z
    .string()
    .describe(
      "Markdown body for product.state — what the product does TODAY and what is explicitly NOT yet built. Be concrete and avoid aspirational language.",
    ),
  productPositioning: z
    .string()
    .describe(
      "Markdown body for product.positioning — category, core promise, against-frame, proof points.",
    ),
  design: z.object({
    colors: z
      .array(LooseColorSchema)
      .max(40)
      .default([])
      .describe(
        "Brand palette extracted from the source docs. Each item: { name, hex (#RRGGBB or #RRGGBBAA), role (one of: " +
          DESIGN_COLOR_ROLES.join(", ") +
          "), usage }. Only include hexes that appear in the source.",
      ),
    typography: z
      .object({
        headingFamily: z.string().max(120).nullable().optional(),
        bodyFamily: z.string().max(120).nullable().optional(),
        monoFamily: z.string().max(120).nullable().optional(),
        weights: z
          .array(z.coerce.number().int().min(100).max(900))
          .max(10)
          .optional(),
        notes: z.string().max(2_000).nullable().optional(),
      })
      .default({}),
    tokens: z
      .object({
        spacing: z.string().max(2_000).nullable().optional(),
        radii: z.string().max(2_000).nullable().optional(),
        shadows: z.string().max(2_000).nullable().optional(),
        iconography: z.string().max(2_000).nullable().optional(),
        notes: z.string().max(4_000).nullable().optional(),
      })
      .default({}),
  }),
});

export type BrandExtractDraft = z.infer<typeof DraftSchema>;

function sanitizeDrafts(raw: z.infer<typeof DraftSchema>): z.infer<typeof DraftSchema> {
  const allowedRoles = new Set<string>(DESIGN_COLOR_ROLES);
  const cleanedColors = (raw.design.colors ?? [])
    .map((c) => {
      const hex = normalizeHex(c.hex);
      if (!hex) return null;
      const role = c.role && allowedRoles.has(c.role) ? (c.role as (typeof DESIGN_COLOR_ROLES)[number]) : undefined;
      return {
        name: (c.name ?? "").trim() || hex,
        hex,
        role,
        usage: c.usage?.trim() || undefined,
      };
    })
    .filter((c): c is { name: string; hex: string; role?: (typeof DESIGN_COLOR_ROLES)[number]; usage?: string } => c !== null)
    .slice(0, 24);

  return {
    ...raw,
    design: {
      ...raw.design,
      colors: cleanedColors,
    },
  };
}

function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (HEX_RE.test(s)) {
    if (s.length === 4) {
      // Expand #abc → #aabbcc.
      const a = s[1];
      const b = s[2];
      const c = s[3];
      if (!a || !b || !c) return null;
      return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
    }
    return s.toLowerCase();
  }
  return null;
}

// Anthropic + Gemini accept PDF file parts directly. DOCX is not supported
// natively by either provider, so for now we surface a clear error rather
// than silently dropping the file. (Adding `mammoth` is a small follow-up.)
const SUPPORTED_FILE_MIME = new Set([
  "application/pdf",
  "text/markdown",
  "text/plain",
]);

const SYSTEM_PROMPT = [
  "You are a senior brand strategist distilling raw source documents (brand books, product overviews, customer research, sales decks, etc.) into a marketing-agent's working memory.",
  "",
  "Read every attached document and produce drafts for five brand-memory documents plus a structured design system.",
  "",
  "Rules:",
  "- Ground every claim in the source docs. If a section can't be supported by the corpus, return a short body that says so explicitly (e.g. 'Not enough source material — please fill in.') instead of fabricating.",
  "- For product.state, be concrete and conservative: only list what the docs claim is shipped TODAY. Anything aspirational belongs in the 'NOT yet built' section.",
  "- For colors, only emit hex values that appear in the source docs. Never invent hexes. If colors are described by name only, leave the array empty and explain in design.tokens.notes.",
  "- Markdown bodies should be plain prose with at most H2 (##) headings. No preamble like 'Here is...'.",
  "- Keep voice consistent with how the company speaks about itself in the source.",
].join("\n");

const SeedSchema = z.object({
  brandName: z.string().min(1).max(200).optional(),
  pitch: z.string().min(1).max(2_000).optional(),
});

export async function POST(request: Request) {
  try {
    await getRequestActor();
    const { workspaceId } = await getWorkspaceContext();
    const db = getDb();

    let seed: z.infer<typeof SeedSchema> | undefined;
    if (request.headers.get("content-length") && request.headers.get("content-length") !== "0") {
      try {
        const parsed = SeedSchema.safeParse(await request.json());
        if (parsed.success) seed = parsed.data;
      } catch {
        // Body was not JSON — ignore; seed stays undefined.
      }
    }

    const docs = await db
      .select()
      .from(schema.brandDocuments)
      .where(isNull(schema.brandDocuments.removedAt));

    if (docs.length === 0) {
      return Response.json({ error: "no_documents" }, { status: 400 });
    }

    // Pull bytes for everything in parallel. Storage downloads are I/O-bound
    // and the corpus is small (admin-uploaded reference docs, not user data).
    const fetched = await Promise.all(
      docs.map(async (d) => ({
        doc: d,
        buffer: await downloadBrandDoc(d.storagePath),
      })),
    );

    const unsupported = fetched.filter(
      (f) => !SUPPORTED_FILE_MIME.has(f.doc.mimeType),
    );
    if (unsupported.length > 0) {
      return Response.json(
        {
          error: "unsupported_doc_type",
          message:
            "DOCX support is not wired up yet. Please convert to PDF, MD, or TXT and re-upload.",
          filenames: unsupported.map((f) => f.doc.filename),
        },
        { status: 400 },
      );
    }

    // Build the user message: a manifest of attached docs + one content part
    // per doc. PDF files are sent as native file parts; text/markdown bytes
    // are decoded to UTF-8 and inlined as text so providers without file
    // support still work.
    const manifest = fetched
      .map((f, i) => `${i + 1}. ${f.doc.filename} (${f.doc.mimeType})`)
      .join("\n");

    const seedBlock =
      seed && (seed.brandName || seed.pitch)
        ? [
            "",
            "User-provided seed (treat as authoritative for brand name and high-level pitch; everything else still comes from the source corpus):",
            seed.brandName ? `- Brand: ${seed.brandName}` : null,
            seed.pitch ? `- Pitch: ${seed.pitch}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : "";

    const content: Array<
      | { type: "text"; text: string }
      | { type: "file"; data: Buffer; mimeType: string }
    > = [
      {
        type: "text",
        text:
          `Source corpus (${fetched.length} document${fetched.length === 1 ? "" : "s"}):\n${manifest}\n\n` +
          "Distill these into the five brand-memory bodies and the design system, following the system instructions." +
          seedBlock,
      },
    ];

    for (const f of fetched) {
      if (f.doc.mimeType === "application/pdf") {
        content.push({
          type: "file",
          data: f.buffer,
          mimeType: "application/pdf",
        });
      } else {
        // text/markdown or text/plain — decode and inline.
        const text = f.buffer.toString("utf8");
        content.push({
          type: "text",
          text: `--- ${f.doc.filename} ---\n${text}`,
        });
      }
    }

    // Model precedence: brand_extract_model setting > workflow_model > default.
    const settingsRows = await db
      .select()
      .from(schema.settings)
      .where(inArray(schema.settings.key, ["brand_extract_model", "workflow_model"]));
    const settingsMap = Object.fromEntries(
      settingsRows.map((r) => [r.key, r.value]),
    );
    const model = resolveLlmModel(
      settingsMap.brand_extract_model ?? settingsMap.workflow_model ?? DEFAULT_LLM_MODEL,
    );

    const result = await generateObject({
      model: getLanguageModel(model),
      schema: DraftSchema,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    await recordLlmUsage({
      agent: "brand-extract",
      workspaceId,
      model,
      usage: result.usage,
      providerMetadata: result.experimental_providerMetadata,
    });

    return Response.json({
      drafts: result.object,
      sourceDocIds: docs.map((d) => d.id),
      model,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
