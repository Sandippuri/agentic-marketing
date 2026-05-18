// show_view + show_form — the two tools that drive UI from the assistant.
//
// Architecture (mirrors apps/server/src/router/widgetChat/uiTools.ts in the
// reference doc, adapted for AI SDK v4):
//   - show_form has NO execute. It surfaces as a tool-invocation with
//     state='call'. The client renders the form and feeds the values back via
//     useChat.addToolResult({ toolCallId, result }). useChat then auto-resumes
//     the stream so the model sees the submitted values in the next step.
//   - show_view HAS execute. It returns a { root, elements } spec; the client
//     just renders it (read-only).
//
// The model never invents UI from markdown — it calls these tools and the
// client maps spec elements to React components via the catalog.

import { tool } from "ai";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────
// Field schema (form inputs)
// ─────────────────────────────────────────────────────────────────────────

export const FieldSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/i)
    .describe("Stable identifier used as the result key."),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "email", "number", "select", "textarea"]),
  placeholder: z.string().max(120).optional(),
  options: z
    .array(z.string().min(1).max(80))
    .optional()
    .describe("Required for type='select'."),
  required: z.boolean().optional(),
});
export type Field = z.infer<typeof FieldSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Block schema (read-only view content)
//
// Blocks are intentionally small primitives. The Strategist's calendar gets a
// dedicated `plan` block so the catalog can render weeks/posts as a card; for
// everything else (drafts, reports, status, key/value summaries) text + table
// + key_value are enough.
// ─────────────────────────────────────────────────────────────────────────

const PlanRowSchema = z.object({
  week: z.number().int().min(1).max(52),
  phase: z.string().min(1).max(40),
  summary: z.string().min(1).max(280),
  postCount: z.number().int().min(0).max(99).optional(),
});

export const BlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("heading"),
    text: z.string().min(1).max(160),
    level: z.enum(["h3", "h4"]).optional(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1).max(4000),
    intent: z.enum(["info", "success", "warning"]).optional(),
  }),
  z.object({
    kind: z.literal("table"),
    columns: z.array(z.string().min(1).max(40)).min(1).max(8),
    rows: z.array(z.array(z.string().max(200)).min(1)).min(0).max(50),
  }),
  z.object({
    kind: z.literal("key_value"),
    items: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          value: z.string().min(1).max(400),
        }),
      )
      .min(1)
      .max(20),
  }),
  z.object({
    kind: z.literal("plan"),
    title: z.string().min(1).max(120).optional(),
    weeks: z.array(PlanRowSchema).min(1).max(12),
  }),
]);
export type Block = z.infer<typeof BlockSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Spec shape (what the renderer consumes)
// ─────────────────────────────────────────────────────────────────────────

export type ElementSpec = {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
  on?: { press?: { action: string; params?: Record<string, unknown> } };
};
export type Spec = { root: string; elements: Record<string, ElementSpec> };

// ─────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────

export function buildFormSpec(input: {
  form_id: string;
  title: string;
  fields: Field[];
  submitLabel?: string;
}): Spec {
  const elements: Record<string, ElementSpec> = {};
  const fieldIds: string[] = [];
  for (const f of input.fields) {
    const id = `field_${f.name}`;
    fieldIds.push(id);
    elements[id] = {
      type:
        f.type === "textarea"
          ? "Textarea"
          : f.type === "select"
            ? "Select"
            : "Input",
      props: {
        label: f.label,
        name: f.name,
        ...(f.type === "select" || f.type === "textarea"
          ? {}
          : { type: f.type }),
        ...(f.options ? { options: f.options } : {}),
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
        ...(f.required ? { required: true } : {}),
        value: { $bindState: `/${f.name}` },
      },
    };
  }
  elements.submit_btn = {
    type: "SubmitButton",
    props: { label: input.submitLabel ?? "Submit" },
    on: {
      press: {
        action: "submit_form",
        params: {
          form_id: input.form_id,
          title: input.title,
          fields: input.fields,
        },
      },
    },
  };
  elements.form_root = {
    type: "FormShell",
    props: { title: input.title },
    children: [...fieldIds, "submit_btn"],
  };
  return { root: "form_root", elements };
}

export function buildViewSpec(input: {
  view_id: string;
  title?: string;
  blocks: Block[];
}): Spec {
  const elements: Record<string, ElementSpec> = {};
  const blockIds: string[] = [];
  input.blocks.forEach((b, i) => {
    const id = `block_${i}`;
    blockIds.push(id);
    switch (b.kind) {
      case "heading":
        elements[id] = {
          type: "Heading",
          props: { text: b.text, ...(b.level ? { level: b.level } : {}) },
        };
        break;
      case "text":
        elements[id] = {
          type: "Text",
          props: { text: b.text, ...(b.intent ? { intent: b.intent } : {}) },
        };
        break;
      case "table":
        elements[id] = {
          type: "Table",
          props: { columns: b.columns, rows: b.rows },
        };
        break;
      case "key_value":
        elements[id] = { type: "KeyValue", props: { items: b.items } };
        break;
      case "plan":
        elements[id] = {
          type: "PlanCard",
          props: {
            ...(b.title ? { title: b.title } : {}),
            weeks: b.weeks,
          },
        };
        break;
    }
  });
  elements.view_root = {
    type: "ViewShell",
    props: input.title ? { title: input.title } : {},
    children: blockIds,
  };
  return { root: "view_root", elements };
}

// ─────────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────────

export function buildUiTools() {
  return {
    show_form: tool({
      description:
        "Present an interactive form to the user and WAIT for them to submit. " +
        "Use this whenever you need structured input from the user " +
        "(channel choice, campaign name, persona pick, content tone, etc.) — " +
        "NEVER list field names as plain text and ask the user to reply in " +
        "freeform. The tool RESULT is an object { [fieldName]: value }; once " +
        "you receive it, continue the conversation using those values. Each " +
        "form needs a stable `form_id` you choose (kebab-case is fine).",
      parameters: z.object({
        form_id: z.string().min(1).max(60),
        title: z.string().min(1).max(120),
        fields: z.array(FieldSchema).min(1).max(8),
        submitLabel: z.string().min(1).max(40).optional(),
      }),
      // NO execute — the client renders the form and feeds values back via
      // addToolResult.
    }),

    suggest_followups: tool({
      description:
        "After you finish answering the user, suggest 2–3 short next " +
        "questions they're most likely to ask. Each item is one short, " +
        "specific phrase (max 60 chars). The UI renders them as clickable " +
        "chips below your message; clicking one sends it as the user's next " +
        "turn. ONLY call this once at the very end of your reply. Skip when " +
        "the conversation has clearly concluded (\"thanks\", a workflow " +
        "dispatched, a definitive answer).",
      parameters: z.object({
        items: z.array(z.string().min(1).max(60)).min(1).max(4),
      }),
      // Server execute just echoes; the client-side chunk splitter picks
      // these up by tool name and renders the chip row.
      execute: async ({ items }) => ({ items }),
    }),

    show_view: tool({
      description:
        "Render a read-only structured panel inline in the chat (plans, " +
        "tables, key/value summaries, status callouts). Use this AFTER a " +
        "sub-agent (run_strategist / run_content / run_analyst) returns " +
        "structured output, instead of dumping the JSON into plain text. " +
        "Block kinds: 'heading', 'text' (with optional intent: info/success/warning), " +
        "'table' (columns + rows), 'key_value' (labelled fields), 'plan' " +
        "(week-by-week calendar — use this for Strategist calendars). " +
        "NEVER use for input (use show_form). Each view needs a stable `view_id`.",
      parameters: z.object({
        view_id: z.string().min(1).max(60),
        title: z.string().min(1).max(120).optional(),
        blocks: z.array(BlockSchema).min(1).max(20),
      }),
      execute: async (input) => buildViewSpec(input),
    }),
  };
}
