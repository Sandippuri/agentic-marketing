import { z } from "zod";
import { randomUUID } from "node:crypto";
import { errorResponse, parseJson } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import { getWorkspaceContext } from "@/lib/billing";
import type { ThreadRef } from "@marketing/shared-types";

// Test-chat HTTP entrypoint.
//
// Two POST contracts share this route:
//
// 1. **Legacy single-text** — `{ text, threadRef?, sessionId?, model?, campaignId? }`
//    Used by apps/web/app/(admin)/campaigns/[id]/campaign-chat.tsx. Returns
//    JSON with `{ reply, threadRef }`, or a bespoke SSE stream when
//    Accept: text/event-stream is present.
//
// 2. **UseChat (AI SDK data stream)** — `{ messages: Message[], threadRef?,
//    sessionId?, model?, campaignId? }`. Used by the rewritten Assistant page
//    in apps/web/app/(admin)/test-chat/chat-client-ready.tsx. Returns the
//    AI SDK data stream response that useChat consumes (text deltas,
//    tool-invocation parts, finish frame). Tool calls / view specs / form
//    requests all arrive as message parts.
//
// The branch is purely on body shape — `messages` array present ⇒ contract 2.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Send = z.object({
  text: z.string().min(1).max(8000).optional(),
  messages: z.array(z.unknown()).optional(),
  threadRef: z.string().optional(),
  sessionId: z.string().optional(),
  model: z.string().optional(),
  campaignId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    const actor = await getRequestActor();
    const ctx = await getWorkspaceContext();
    const input = await parseJson(request, Send);
    const userId = actor.id ?? "admin";

    if (input.messages && input.messages.length > 0) {
      return await handleUiStream({
        messages: input.messages as never,
        threadRef: input.threadRef,
        sessionId: input.sessionId,
        model: input.model,
        userId,
        workspaceId: ctx.workspaceId,
        campaignId: input.campaignId,
      });
    }

    if (!input.text) {
      return Response.json(
        { error: "either `messages` or `text` is required" },
        { status: 400 },
      );
    }

    const wantsStream = (request.headers.get("accept") ?? "").includes(
      "text/event-stream",
    );

    if (wantsStream) {
      return await handleLegacyStream({
        text: input.text,
        threadRef: input.threadRef,
        sessionId: input.sessionId,
        model: input.model,
        userId,
        workspaceId: ctx.workspaceId,
        campaignId: input.campaignId,
      });
    }

    return await handleLegacySync({
      text: input.text,
      threadRef: input.threadRef,
      sessionId: input.sessionId,
      model: input.model,
      userId,
      workspaceId: ctx.workspaceId,
      campaignId: input.campaignId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function mintThreadRef(sessionId: string | undefined): {
  threadRef: ThreadRef;
  sessionId: string;
} {
  const session = sessionId ?? randomUUID().replace(/-/g, "").slice(0, 12);
  const threadId = randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    threadRef: `web:S${session}:T${threadId}` as ThreadRef,
    sessionId: session,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Contract 2: useChat (AI SDK data stream)
// ──────────────────────────────────────────────────────────────────────────

async function handleUiStream(input: {
  messages: import("ai").Message[];
  threadRef?: string;
  sessionId?: string;
  model?: string;
  userId: string;
  workspaceId: string;
  campaignId?: string;
}): Promise<Response> {
  const { handleChatUiStream } = await import("@/lib/chat/chat-handler");
  const { CpClient } = await import("@marketing/cp-client");

  const { threadRef } = input.threadRef
    ? { threadRef: input.threadRef as ThreadRef }
    : mintThreadRef(input.sessionId);

  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  const cp = new CpClient({
    baseUrl,
    internalToken,
    workspaceId: input.workspaceId,
  });

  return await handleChatUiStream({
    messages: input.messages,
    userId: input.userId,
    workspaceId: input.workspaceId,
    threadRef,
    cp,
    model: input.model,
    campaignId: input.campaignId,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Contract 1: legacy single-text (sync + bespoke SSE)
// ──────────────────────────────────────────────────────────────────────────

async function handleLegacySync(input: {
  text: string;
  threadRef?: string;
  sessionId?: string;
  model?: string;
  userId: string;
  workspaceId: string;
  campaignId?: string;
}): Promise<Response> {
  const { handleChat } = await import("@/lib/chat/chat-handler");
  const { CpClient } = await import("@marketing/cp-client");

  const { threadRef } = input.threadRef
    ? { threadRef: input.threadRef as ThreadRef }
    : mintThreadRef(input.sessionId);

  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  const cp = new CpClient({
    baseUrl,
    internalToken,
    workspaceId: input.workspaceId,
  });

  const reply = await handleChat({
    text: input.text,
    userId: input.userId,
    workspaceId: input.workspaceId,
    threadRef,
    cp,
    model: input.model,
    campaignId: input.campaignId,
  });
  return Response.json({ reply, threadRef });
}

async function handleLegacyStream(input: {
  text: string;
  threadRef?: string;
  sessionId?: string;
  model?: string;
  userId: string;
  workspaceId: string;
  campaignId?: string;
}): Promise<Response> {
  const { handleChatStream } = await import("@/lib/chat/chat-handler");
  const { CpClient } = await import("@marketing/cp-client");

  const { threadRef } = input.threadRef
    ? { threadRef: input.threadRef as ThreadRef }
    : mintThreadRef(input.sessionId);

  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  const cp = new CpClient({
    baseUrl,
    internalToken,
    workspaceId: input.workspaceId,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
        );
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      send({ kind: "meta", threadRef });

      void handleChatStream({
        text: input.text,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadRef,
        cp,
        model: input.model,
        campaignId: input.campaignId,
        onEvent: (event) => {
          send(event);
          if (event.kind === "done" || event.kind === "error") {
            close();
          }
          if (event.kind === "workflow_started") {
            close();
          }
        },
      }).catch((err) => {
        send({
          kind: "error",
          message: (err as Error).message ?? "unknown error",
        });
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
