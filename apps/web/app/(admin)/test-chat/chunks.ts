// Walk a Message[] from useChat and flatten each turn's `parts` array into
// an ordered list of visual chunks. Rendering at message granularity would
// glue text + tool calls + view specs into one bubble; the assistant's turn
// is often [text → show_view → text → tool_call → text] and the user expects
// to see them in that exact order.
//
// One chunk per visual element. The renderer in chat-client-ready.tsx maps
// `chunk.kind` to a component via ChatChunk.

import type { Message } from "ai";
import type { Spec } from "@/lib/chat/ui-tools";

export type Chunk =
  | { kind: "user_text"; key: string; messageId: string; text: string }
  | { kind: "ai_text"; key: string; messageId: string; text: string }
  | { kind: "ai_view"; key: string; messageId: string; spec: Spec; viewId?: string }
  | {
      kind: "form";
      key: string;
      messageId: string;
      toolCallId: string;
      input: { form_id: string; title: string; fields: FormField[]; submitLabel?: string };
      submitted: boolean;
      submittedValues?: Record<string, string | number>;
    }
  | {
      kind: "tool_call";
      key: string;
      messageId: string;
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
      state: "call" | "partial-call" | "result";
      result?: unknown;
    }
  | {
      kind: "suggestions";
      key: string;
      messageId: string;
      items: string[];
    };

export type FormField = {
  name: string;
  label: string;
  type: "text" | "email" | "number" | "select" | "textarea";
  placeholder?: string;
  options?: string[];
  required?: boolean;
};

// Tools that the chat catalog has dedicated UI for; everything else falls
// into the generic tool_call chip. Keep this list small — adding a new tool
// here should be intentional.
const UI_TOOLS = new Set(["show_form", "show_view", "suggest_followups"]);

export function splitMessages(messages: Message[]): Chunk[] {
  const out: Chunk[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      pushUser(out, msg);
      continue;
    }
    if (msg.role !== "assistant") continue;
    pushAssistant(out, msg);
  }
  return out;
}

function pushUser(out: Chunk[], msg: Message): void {
  if (msg.parts && msg.parts.length > 0) {
    msg.parts.forEach((p, i) => {
      if (p.type === "text" && p.text) {
        out.push({
          kind: "user_text",
          key: `${msg.id}:${i}`,
          messageId: msg.id,
          text: p.text,
        });
      }
    });
    return;
  }
  if (msg.content) {
    out.push({
      kind: "user_text",
      key: msg.id,
      messageId: msg.id,
      text: msg.content,
    });
  }
}

function pushAssistant(out: Chunk[], msg: Message): void {
  if (!msg.parts || msg.parts.length === 0) {
    // Pre-parts message (legacy or very early stream frame). Render content
    // as a single ai_text bubble so nothing disappears.
    if (msg.content) {
      out.push({
        kind: "ai_text",
        key: msg.id,
        messageId: msg.id,
        text: msg.content,
      });
    }
    return;
  }

  msg.parts.forEach((part, i) => {
    const key = `${msg.id}:${i}`;
    if (part.type === "text") {
      if (part.text)
        out.push({
          kind: "ai_text",
          key,
          messageId: msg.id,
          text: part.text,
        });
      return;
    }
    if (part.type !== "tool-invocation") return;
    const inv = part.toolInvocation;
    const toolName = inv.toolName;

    if (toolName === "show_form") {
      // No result yet → render the live form. With result → render echo
      // (read-only summary of what was submitted).
      if (inv.state === "partial-call") return;
      out.push({
        kind: "form",
        key: `${msg.id}:${inv.toolCallId}`,
        messageId: msg.id,
        toolCallId: inv.toolCallId,
        input: inv.args as Chunk extends { kind: "form"; input: infer I }
          ? I
          : never,
        submitted: inv.state === "result",
        submittedValues:
          inv.state === "result"
            ? (inv.result as Record<string, string | number>)
            : undefined,
      });
      return;
    }

    if (toolName === "show_view") {
      // The view spec is the tool RESULT (show_view has a server execute
      // that builds the spec).
      if (inv.state !== "result") return;
      const spec = inv.result as Spec | undefined;
      if (!spec || !spec.root || !spec.elements) return;
      out.push({
        kind: "ai_view",
        key: `${msg.id}:${inv.toolCallId}`,
        messageId: msg.id,
        spec,
        viewId: (inv.args as { view_id?: string } | undefined)?.view_id,
      });
      return;
    }

    if (toolName === "suggest_followups") {
      // Tool execute echoes the items it received. Skip until they arrive so
      // we don't render an empty chip row mid-stream.
      if (inv.state !== "result") return;
      const result = inv.result as { items?: unknown } | undefined;
      const items = Array.isArray(result?.items)
        ? (result!.items as unknown[]).filter(
            (s): s is string => typeof s === "string" && s.length > 0,
          )
        : [];
      if (items.length === 0) return;
      out.push({
        kind: "suggestions",
        key: `${msg.id}:${inv.toolCallId}`,
        messageId: msg.id,
        items,
      });
      return;
    }

    if (UI_TOOLS.has(toolName)) return; // already handled above

    // Generic tool chip — keeps the user informed without exposing JSON.
    out.push({
      kind: "tool_call",
      key: `${msg.id}:${inv.toolCallId}`,
      messageId: msg.id,
      toolName,
      toolCallId: inv.toolCallId,
      args: (inv.args ?? {}) as Record<string, unknown>,
      state: inv.state,
      result: inv.state === "result" ? inv.result : undefined,
    });
  });
}
