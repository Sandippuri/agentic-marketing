# AI `show_view` / `show_form` Architecture — Implementing in a Simple React Chatbot

This doc explains the architecture used in `apps/server/src/router/widgetChat/` + `apps/client/src/components/chatbot-widget/` and shows how to recreate it in a minimal React chatbot.

## The big idea (one paragraph)

The AI doesn't write HTML and the server doesn't render HTML. Instead, the AI **calls two tools** — `show_form` to collect structured input, `show_view` to display structured output — and those tools return / accept **JSON UI specs**. The React client owns a tiny **component catalog**, walks the model's message parts in order, and renders the spec inline as a chat bubble. Forms are *human-in-the-loop*: the server defines the tool with **no `execute()`**, the client renders the form, the user submits, and the submitted values are sent back to the model via `addToolResult()` as the tool's result. Views are server-resolved: `execute()` builds a spec from the AI's chosen blocks and returns it; the client just renders it.

Two architectural decisions to internalize:

1. **Tool calls are the UI driver.** The model decides "now is the moment for a form / a table" by emitting a tool call. You never parse markdown for `[FORM]` markers or anything like that.
2. **The spec is the contract.** The server emits `{ root, elements }` JSON. The client maps element `type` strings to React components via a registry. Add a new element by adding a new entry in both places — nothing else.

---

## Architecture diagram (in words)

```
User types message
   │
   ▼
useChat (AI SDK) ──► POST /chat ──► streamText({ model, tools: { show_form, show_view, … } })
                                         │
                                         ├─ model emits text → streamed back as text part
                                         ├─ model calls show_form(input) → NO execute; tool part streamed
                                         │      with state=input-available, no output yet
                                         └─ model calls show_view(input) → execute(input) returns Spec;
                                                tool part streamed with state=output-available, output=Spec

Client receives UIMessage with mixed parts:
   [ text, tool(show_form, no output), text, tool(show_view, output=Spec), text, … ]
   │
   ▼
splitMessages(msgs) → ordered Chunk[]:
   user_text | ai_text | ai_view(spec) | echo(form fields + submitted values) | ai_badges
   │
   ▼
<ChatChunk> renders each chunk:
   ai_view → <ViewRenderer spec={spec} />
   show_form (no result yet) → <FormRenderer spec={buildFormSpec(input)} onSubmit={…} />
   echo (form already submitted) → read-only summary of the values

User submits the form:
   onSubmit(values) → addToolResult({ toolCallId, output: values })
                                          │
                                          ▼
                       useChat auto-resumes the stream; model sees the values
                       in conversation history and continues.
```

---

## File-by-file reference (in this repo)

| Concern | File | What it does |
|---|---|---|
| Tool definitions + spec builders | [apps/server/src/router/widgetChat/uiTools.ts](../apps/server/src/router/widgetChat/uiTools.ts) | Zod schemas for fields & blocks; `buildFormSpec()`, `buildViewSpec()`; `show_form` (no execute) + `show_view` (execute returns Spec). |
| Server chat handler | [apps/server/src/router/widgetChatRouter.ts](../apps/server/src/router/widgetChatRouter.ts) | `streamText({ model, tools })` over the AI SDK. |
| `useChat` wrapper | [apps/client/src/components/chatbot-widget/useWidgetChat.ts](../apps/client/src/components/chatbot-widget/useWidgetChat.ts) | Transport, auto-resume after client tool result, session JWT handling. |
| Message → chunk splitter | [apps/client/src/components/chatbot-widget/chunks.ts](../apps/client/src/components/chatbot-widget/chunks.ts) | Walks `msg.parts`, emits ordered visual chunks. |
| Chunk renderer | [apps/client/src/components/chatbot-widget/ChatChunk.tsx](../apps/client/src/components/chatbot-widget/ChatChunk.tsx) | Switch on `chunk.kind` → component. |
| Form + view renderers | [apps/client/src/components/chatbot-widget/ui-catalog.tsx](../apps/client/src/components/chatbot-widget/ui-catalog.tsx) | `FormRenderer` (with state store + handlers), `ViewRenderer` (read-only). |
| Component catalog | [apps/client/src/components/chatbot-widget/catalog/](../apps/client/src/components/chatbot-widget/catalog/) | shadcn-based primitives + custom widgets (date, otp, multiselect, etc.) registered for `@json-render`. |

---

## The spec format

A spec is `{ root, elements }`. `elements` is a flat map of `id → { type, props, children?, on? }`. `children` is an array of element ids — that's how nesting works, by id reference, not by nested objects.

### Form spec example (what `buildFormSpec` produces)

```json
{
  "root": "form_root",
  "elements": {
    "field_email": {
      "type": "Input",
      "props": {
        "label": "Email",
        "name": "email",
        "type": "email",
        "value": { "$bindState": "/email" },
        "placeholder": "you@example.com"
      }
    },
    "submit_btn": {
      "type": "SubmitButton",
      "props": { "label": "Submit" },
      "on": {
        "press": {
          "action": "submit_form",
          "params": {
            "form_id": "book_appt_001",
            "title": "Book appointment",
            "fields": [{ "name": "email", "label": "Email", "type": "email" }]
          }
        }
      }
    },
    "form_root": {
      "type": "FormShell",
      "props": { "title": "Book appointment" },
      "children": ["field_email", "submit_btn"]
    }
  }
}
```

Key bits:
- `{ "$bindState": "/email" }` — two-way binding. The renderer reads from / writes to `store.get("/email")`.
- `on.press` on the submit button — fires the `submit_form` handler the client registered, passing the listed `fields` so the handler knows which keys to harvest from the store.

### View spec example (what `buildViewSpec` produces)

```json
{
  "root": "view_root",
  "elements": {
    "block_0": { "type": "Heading", "props": { "text": "Top sellers", "level": "h3" } },
    "block_1": {
      "type": "Table",
      "props": { "columns": ["Item", "Sold"], "rows": [["Latte", "42"], ["Mocha", "31"]] }
    },
    "view_root": {
      "type": "ViewShell",
      "props": { "title": "Last 7 days" },
      "children": ["block_0", "block_1"]
    }
  },
  "view_id": "top_sellers_7d"
}
```

Views are stateless: no `$bindState`, no handlers, just a tree.

---

## Implementing this in a simple React chatbot

Below is the minimum you need. It uses **Vercel AI SDK** (`ai`, `@ai-sdk/react`) and a hand-rolled mini-renderer (no `@json-render` dependency) so you can see what each layer is doing.

### 1. Server: define the tools

```ts
// server/chat.ts (Node / edge / hono / express — pick your runtime)
import { streamText, tool, convertToCoreMessages } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const fieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "email", "number", "select", "textarea"]),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const blockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), text: z.string() }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("table"), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ kind: z.literal("key_value"), items: z.array(z.object({ label: z.string(), value: z.string() })) }),
]);

function buildFormSpec(input: { form_id: string; title: string; fields: z.infer<typeof fieldSchema>[] }) {
  const elements: Record<string, any> = {};
  const fieldIds: string[] = [];
  for (const f of input.fields) {
    const id = `field_${f.name}`;
    fieldIds.push(id);
    elements[id] = {
      type: f.type === "textarea" ? "Textarea" : f.type === "select" ? "Select" : "Input",
      props: {
        label: f.label,
        name: f.name,
        type: f.type === "select" || f.type === "textarea" ? undefined : f.type,
        options: f.options,
        placeholder: f.placeholder,
        value: { $bindState: `/${f.name}` },
      },
    };
  }
  elements.submit_btn = {
    type: "SubmitButton",
    props: { label: "Submit" },
    on: { press: { action: "submit_form", params: { form_id: input.form_id, title: input.title, fields: input.fields } } },
  };
  elements.form_root = { type: "FormShell", props: { title: input.title }, children: [...fieldIds, "submit_btn"] };
  return { root: "form_root", elements };
}

function buildViewSpec(input: { view_id: string; title?: string; blocks: z.infer<typeof blockSchema>[] }) {
  const elements: Record<string, any> = {};
  const blockIds: string[] = [];
  input.blocks.forEach((b, i) => {
    const id = `block_${i}`;
    blockIds.push(id);
    if (b.kind === "heading") elements[id] = { type: "Heading", props: { text: b.text } };
    else if (b.kind === "text") elements[id] = { type: "Text", props: { text: b.text } };
    else if (b.kind === "table") elements[id] = { type: "Table", props: { columns: b.columns, rows: b.rows } };
    else if (b.kind === "key_value") elements[id] = { type: "KeyValue", props: { items: b.items } };
  });
  elements.view_root = { type: "ViewShell", props: { title: input.title }, children: blockIds };
  return { root: "view_root", elements };
}

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: anthropic("claude-haiku-4-5-20251001"),
    messages: convertToCoreMessages(messages),
    system: "You are a helpful assistant. Use show_form to collect structured input. Use show_view to present tabular or structured output. Never ask for fields in plain text — always call show_form.",
    tools: {
      show_form: tool({
        description: "Present an interactive form to the user and WAIT for them to submit. The tool RESULT is { [fieldName]: value }. Use show_form whenever you need structured input.",
        inputSchema: z.object({
          form_id: z.string(),
          title: z.string(),
          fields: z.array(fieldSchema).min(1),
        }),
        // NO execute — the client renders the form and addToolResult sends the values back.
      }),
      show_view: tool({
        description: "Render read-only structured data inline in the chat. Use for tables, key-value summaries, headings. NEVER use for input.",
        inputSchema: z.object({
          view_id: z.string(),
          title: z.string().optional(),
          blocks: z.array(blockSchema).min(1),
        }),
        execute: async (input) => buildViewSpec(input),
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
```

The critical asymmetry: **`show_form` has no `execute`**, **`show_view` does**. That's what makes one a "wait for user" tool and the other a "render this output" tool.

### 2. Client: the chunk splitter

```ts
// client/chunks.ts
import { isToolUIPart, getToolName, type UIMessage } from "ai";

export type Spec = { root: string; elements: Record<string, any> };
export type Chunk =
  | { kind: "user_text"; key: string; text: string }
  | { kind: "ai_text"; key: string; text: string }
  | { kind: "ai_view"; key: string; spec: Spec }
  | { kind: "form"; key: string; toolCallId: string; input: any; submitted: boolean; output?: any };

export function splitMessages(messages: UIMessage[]): Chunk[] {
  const out: Chunk[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      msg.parts.forEach((p, i) => p.type === "text" && p.text && out.push({ kind: "user_text", key: `${msg.id}:${i}`, text: p.text }));
      continue;
    }
    msg.parts.forEach((part, i) => {
      if (part.type === "text" && part.text) {
        out.push({ kind: "ai_text", key: `${msg.id}:${i}`, text: part.text });
        return;
      }
      if (!isToolUIPart(part)) return;
      const name = getToolName(part);
      const anyPart = part as any;
      if (name === "show_form" && anyPart.state !== "input-streaming") {
        out.push({
          kind: "form",
          key: `${msg.id}:${anyPart.toolCallId}`,
          toolCallId: anyPart.toolCallId,
          input: anyPart.input,
          submitted: anyPart.state === "output-available",
          output: anyPart.output,
        });
        return;
      }
      if (name === "show_view" && anyPart.state === "output-available") {
        out.push({ kind: "ai_view", key: `${msg.id}:${anyPart.toolCallId}`, spec: anyPart.output });
      }
    });
  }
  return out;
}
```

This is where the magic happens. The AI SDK packs an entire assistant turn (text → form → text → table → text) into **one** message with many parts. You **must** walk parts in order and emit one chunk each, otherwise everything glues together into one giant bubble.

### 3. Client: a 60-line mini renderer

```tsx
// client/MiniRenderer.tsx
import { useSyncExternalStore } from "react";

export type Spec = { root: string; elements: Record<string, any> };

// Tiny state store with JSON-pointer-ish "/key" paths.
export function createStateStore(initial: Record<string, any> = {}) {
  let state = { ...initial };
  const listeners = new Set<() => void>();
  return {
    get: (path: string) => state[path.slice(1)],
    set: (path: string, value: any) => {
      state = { ...state, [path.slice(1)]: value };
      listeners.forEach((l) => l());
    },
    snapshot: () => state,
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  };
}

type Store = ReturnType<typeof createStateStore>;
type Handlers = Record<string, (params: any) => void>;
type Registry = Record<string, (props: any, ctx: { store: Store; handlers: Handlers; renderChildren: (ids: string[]) => React.ReactNode }) => React.ReactNode>;

// Resolve { $bindState: "/foo" } props into live values + onChange.
function bindProps(props: any, store: Store) {
  const useStore = (path: string) => useSyncExternalStore(store.subscribe, () => store.get(path), () => store.get(path));
  const out: any = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v && typeof v === "object" && "$bindState" in v) {
      const path = (v as any).$bindState;
      // We expose both `value` and `onValueChange` so each component can wire what it needs.
      out[k] = useStore(path);
      out[`on${k[0].toUpperCase()}${k.slice(1)}Change`] = (next: any) => store.set(path, next);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function MiniRenderer({ spec, registry, store, handlers }: { spec: Spec; registry: Registry; store: Store; handlers: Handlers }) {
  const renderNode = (id: string): React.ReactNode => {
    const node = spec.elements[id];
    if (!node) return null;
    const Component = registry[node.type];
    if (!Component) return <span style={{ color: "red" }}>Unknown: {node.type}</span>;
    const props = bindProps(node.props, store);
    // Wire on.press / on.* handlers.
    if (node.on?.press) {
      const { action, params } = node.on.press;
      props.onPress = () => handlers[action]?.(params);
    }
    return <Component key={id} {...props} renderChildren={() => (node.children ?? []).map(renderNode)} />;
  };
  return <>{renderNode(spec.root)}</>;
}
```

> **Why `useSyncExternalStore`?** It's React's safe primitive for subscribing to outside-of-React state without tearing during concurrent rendering. With it, the bound `<Input>` re-renders the moment the store changes, no `useState` needed in each component.

### 4. Client: the catalog

```tsx
// client/catalog.tsx
import { type ReactNode } from "react";

export const registry = {
  FormShell: ({ title, renderChildren }: { title?: string; renderChildren: () => ReactNode }) => (
    <form onSubmit={(e) => e.preventDefault()} style={{ display: "grid", gap: 8, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
      {title && <h4 style={{ margin: 0 }}>{title}</h4>}
      {renderChildren()}
    </form>
  ),
  Input: ({ label, type = "text", value, onValueChange, placeholder }: any) => (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <input type={type} value={value ?? ""} placeholder={placeholder} onChange={(e) => onValueChange(e.target.value)} />
    </label>
  ),
  Textarea: ({ label, value, onValueChange, placeholder }: any) => (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <textarea value={value ?? ""} placeholder={placeholder} onChange={(e) => onValueChange(e.target.value)} rows={3} />
    </label>
  ),
  Select: ({ label, options = [], value, onValueChange }: any) => (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <select value={value ?? ""} onChange={(e) => onValueChange(e.target.value)}>
        <option value="" disabled>Pick one…</option>
        {options.map((o: string) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  ),
  SubmitButton: ({ label, onPress }: any) => (
    <button type="button" onClick={onPress} style={{ padding: "6px 12px", background: "#111", color: "white", borderRadius: 6 }}>{label}</button>
  ),

  ViewShell: ({ title, renderChildren }: any) => (
    <div style={{ display: "grid", gap: 8, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
      {title && <h4 style={{ margin: 0 }}>{title}</h4>}
      {renderChildren()}
    </div>
  ),
  Heading: ({ text }: any) => <h5 style={{ margin: 0 }}>{text}</h5>,
  Text: ({ text }: any) => <p style={{ margin: 0 }}>{text}</p>,
  Table: ({ columns = [], rows = [] }: any) => (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead><tr>{columns.map((c: string) => <th key={c} style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 4 }}>{c}</th>)}</tr></thead>
      <tbody>{rows.map((r: string[], i: number) => <tr key={i}>{r.map((cell, j) => <td key={j} style={{ padding: 4, borderBottom: "1px solid #f0f0f0" }}>{cell}</td>)}</tr>)}</tbody>
    </table>
  ),
  KeyValue: ({ items = [] }: any) => (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: 4 }}>
      {items.map((it: { label: string; value: string }, i: number) => (
        <FragmentRow key={i} label={it.label} value={it.value} />
      ))}
    </dl>
  ),
};

const FragmentRow = ({ label, value }: { label: string; value: string }) => (
  <>
    <dt style={{ color: "#666" }}>{label}</dt>
    <dd style={{ margin: 0 }}>{value}</dd>
  </>
);
```

### 5. Client: form & view renderers

```tsx
// client/renderers.tsx
import { useMemo, useEffect, useRef } from "react";
import { MiniRenderer, createStateStore, type Spec } from "./MiniRenderer";
import { registry } from "./catalog";

type FieldDescriptor = { name: string; label: string; type: string };
type FormSubmitPayload = { form_id: string; title: string; fields: FieldDescriptor[]; values: Record<string, any> };

export function FormRenderer({ spec, isSubmitted, onSubmit }: { spec: Spec; isSubmitted: boolean; onSubmit: (p: FormSubmitPayload) => void }) {
  const store = useMemo(() => createStateStore({ submitted: isSubmitted }), []); // build ONCE
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => { onSubmitRef.current = onSubmit; });

  const handlers = useMemo(() => ({
    submit_form: (params: { form_id: string; title: string; fields: FieldDescriptor[] }) => {
      const snap = store.snapshot();
      const values: Record<string, any> = {};
      for (const f of params.fields) values[f.name] = snap[f.name];
      onSubmitRef.current({ form_id: params.form_id, title: params.title, fields: params.fields, values });
    },
  }), [store]);

  return <MiniRenderer spec={spec} registry={registry} store={store} handlers={handlers} />;
}

export function ViewRenderer({ spec }: { spec: Spec }) {
  const store = useMemo(() => createStateStore({}), []);
  return <MiniRenderer spec={spec} registry={registry} store={store} handlers={{}} />;
}
```

### 6. Client: the chat UI tying it together

```tsx
// client/Chat.tsx
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName, type UIMessage } from "ai";
import { useMemo, useRef } from "react";
import { splitMessages } from "./chunks";
import { FormRenderer, ViewRenderer } from "./renderers";

// Same form-spec builder as on the server. Keeping it client-side too means
// we don't have to ship the spec across the wire — we rebuild it from the
// tool input. (You can alternatively let `show_form` execute() return the
// spec, just like `show_view` does. Either works.)
function buildFormSpec(input: any) { /* …copy from server… */ }

export function Chat() {
  // Auto-resume after the user submits a form so the model sees their values.
  const resumedRef = useRef<Set<string>>(new Set());
  const sendAutomaticallyWhen = useMemo(
    () => ({ messages }: { messages: UIMessage[] }) => {
      const last = messages.at(-1);
      if (!last || last.role !== "assistant") return false;
      const forms = last.parts.filter((p) => isToolUIPart(p) && getToolName(p) === "show_form") as any[];
      if (!forms.length || !forms.every((p) => p.state === "output-available")) return false;
      const fresh = forms.find((p) => !resumedRef.current.has(p.toolCallId));
      if (!fresh) return false;
      forms.forEach((p) => resumedRef.current.add(p.toolCallId));
      return true;
    },
    [],
  );

  const { messages, sendMessage, addToolResult, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    sendAutomaticallyWhen,
  });
  const chunks = splitMessages(messages);

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>
      <div style={{ display: "grid", gap: 12 }}>
        {chunks.map((c) => {
          if (c.kind === "user_text") return <div key={c.key} style={{ textAlign: "right" }}>{c.text}</div>;
          if (c.kind === "ai_text") return <div key={c.key}>{c.text}</div>;
          if (c.kind === "ai_view") return <ViewRenderer key={c.key} spec={c.spec} />;
          if (c.kind === "form") {
            const spec = buildFormSpec(c.input);
            return (
              <FormRenderer
                key={c.key}
                spec={spec}
                isSubmitted={c.submitted}
                onSubmit={(payload) => {
                  // Send values BACK to the model as the tool's result.
                  // The model's next step sees them in conversation history.
                  addToolResult({ toolCallId: c.toolCallId, tool: "show_form", output: payload.values });
                }}
              />
            );
          }
          return null;
        })}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); sendMessage({ text: String(fd.get("msg") ?? "") }); e.currentTarget.reset(); }} style={{ marginTop: 16 }}>
        <input name="msg" placeholder={status === "ready" ? "Say something…" : "…"} style={{ width: "100%", padding: 8 }} />
      </form>
    </div>
  );
}
```

That's the whole loop.

---

## Where each subtlety lives (don't skip these)

These are the things that look optional but bite you if you skip them. All quoted from the prod implementation in this repo.

### 1. **Auto-resume after form submission**

After the user submits, the model needs to see the values *and continue its turn*. The AI SDK does this if you pass `sendAutomaticallyWhen`. The condition must be: "last assistant message has at least one `show_form` part, all `show_form` parts have `state === 'output-available'`, and at least one of them hasn't been resumed yet." See [useWidgetChat.ts:108-123](../apps/client/src/components/chatbot-widget/useWidgetChat.ts#L108-L123). Without the "not already resumed" guard you get an infinite resume loop.

### 2. **Build the form-state store ONCE per form**

`useMemo(() => createStateStore(...), [])` with **empty deps**. If you key it on spec or props, every render rebuilds the store and the user's typing disappears. The prod code has an explicit eslint-disable on this. See [ui-catalog.tsx:23-29](../apps/client/src/components/chatbot-widget/ui-catalog.tsx#L23-L29).

### 3. **Walk message parts, don't render one bubble per message**

A single assistant turn can be `[text, show_form, text, show_view, text]`. Rendering message-level glues prose into one bubble and reorders forms/views weirdly. The `splitMessages` function exists precisely to flatten parts into an ordered chunk list. See [chunks.ts:23-97](../apps/client/src/components/chatbot-widget/chunks.ts#L23-L97).

### 4. **`show_form` has NO `execute()`. `show_view` HAS `execute()`.**

This is the contract for "human-in-the-loop vs server-resolved":
- No `execute()` → the tool call sits in `state: input-available` until the client calls `addToolResult()`. The client owns the moment of completion.
- With `execute()` → the AI SDK runs it, attaches the return value as `output`, the tool part lands in `state: output-available`. Client just renders.

You can mix them. `claim_send_otp` in this repo runs server-side; `show_form` is client-side. Both flow through the same message-parts protocol.

### 5. **"Other" / custom-value handling for select/radio/multiselect**

In the prod renderer ([ui-catalog.tsx:46-58](../apps/client/src/components/chatbot-widget/ui-catalog.tsx#L46-L58)), when the field's value is `"Other"` the renderer reads `${name}__other` from the store and substitutes that as the actual value before submitting. The Select/Radio components show the "Other" row themselves when `allowCustom: true`. The model never emits `"Other"` as an option — it only sets `allowCustom: true` and the widget handles UX. Worth replicating once your form needs more than closed enums.

### 6. **Tool description is your prompt**

Look at [uiTools.ts:341-349](../apps/server/src/router/widgetChat/uiTools.ts#L341-L349). The `description` for `show_form` is six sentences of *behavioral* guidance: "always call show_form for input", "multiselect for pick-one-or-more, not multiple checkboxes", "never list field names in plain text". The model reads this every turn. If you skimp on the description, the model invents its own form UX (markdown lists, free-text Qs). The description is the cheapest reliability lever you have.

### 7. **Spec is `{ root, elements }`, not a tree**

Children are id references, not nested objects. This sounds annoying but pays off: every element has a stable identity, the renderer is O(n), and you can lazy-resolve unknown types without descending into them. Stick with the flat shape.

### 8. **State store paths use `/key`, not just `key`**

`{ $bindState: "/email" }`, not `"email"`. The leading slash is JSON-pointer convention; it leaves room for nested paths (`/address/street`) later without a schema change. Use it from day one.

---

## What to add next (when the simple version isn't enough)

- **Streaming tool inputs.** The AI SDK can stream tool inputs token by token (`state: input-streaming`). You can show a "preparing form…" skeleton during that phase. The prod widget exposes `activeToolName` for exactly this — see [useWidgetChat.ts:147-149](../apps/client/src/components/chatbot-widget/useWidgetChat.ts#L147-L149).
- **`@json-render/react`.** Replace the 60-line `MiniRenderer` with the real library if you want richer spec features (computed bindings, conditional rendering, more handlers). The shape is the same.
- **More field types.** Date, OTP, phone, slider, switch, multiselect-with-Other. See [catalog/](../apps/client/src/components/chatbot-widget/catalog/) — each is a single small file.
- **More view blocks.** Alerts, badges, stats grids, progress, images. See [uiTools.ts:62-111](../apps/server/src/router/widgetChat/uiTools.ts#L62-L111) for the Zod definitions and [uiTools.ts:220-336](../apps/server/src/router/widgetChat/uiTools.ts#L220-L336) for the spec builder.
- **Tool-call badges.** Show a chip per tool call ("send otp", "verify otp") so the user sees what the AI did even when the result isn't visually rendered. The prod widget renders these as `ai_badges` chunks — see [ChatChunk.tsx:33-43](../apps/client/src/components/chatbot-widget/ChatChunk.tsx#L33-L43).
- **Multi-tool workflows.** The `claim_chatbot` flow in [uiTools.ts:384-602](../apps/server/src/router/widgetChat/uiTools.ts#L384-L602) chains six tools (start → show_form email → send OTP → show_form OTP → verify → show_form org pick → finalize → show_view success). It works because each tool description tells the model what the *next* tool is. The model orchestrates; you just declare.

---

## TL;DR

1. Define two tools server-side: `show_form` (no execute, schema describes fields) and `show_view` (execute returns a `{ root, elements }` spec).
2. Client uses `useChat` with `sendAutomaticallyWhen` so form submissions auto-resume the stream.
3. Walk `msg.parts` in order to produce visual chunks; never render one bubble per message.
4. Catalog maps `type` strings to React components. Two-way binding via `{ $bindState: "/path" }` + a single store per form.
5. On submit, call `addToolResult({ toolCallId, output: values })` — the model picks up where it left off.

Everything else is polish.
