import { z } from "zod";
import { randomUUID } from "node:crypto";
import { errorResponse, parseJson } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import { getWorkspaceContext } from "@/lib/billing";
import type { ThreadRef } from "@marketing/shared-types";

// Test-chat HTTP entrypoint. Phase 4 cutover: the legacy proxy to apps/manager
// is gone — the orchestrator runs in-process via @/lib/chat/handleChat.

const Send = z.object({
  text: z.string().min(1).max(8000),
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

    const wantsStream = (request.headers.get("accept") ?? "").includes(
      "text/event-stream",
    );

    if (wantsStream) {
      return await handleInProcessStream({
        text: input.text,
        threadRef: input.threadRef,
        sessionId: input.sessionId,
        model: input.model,
        userId,
        workspaceId: ctx.workspaceId,
        campaignId: input.campaignId,
      });
    }

    return await handleInProcess({
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

async function handleInProcess(input: {
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

  const sessionId =
    input.sessionId ?? randomUUID().replace(/-/g, "").slice(0, 12);
  const threadId = randomUUID().replace(/-/g, "").slice(0, 12);
  const threadRef = (input.threadRef ??
    `web:S${sessionId}:T${threadId}`) as ThreadRef;

  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  const cp = new CpClient({ baseUrl, internalToken });

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

async function handleInProcessStream(input: {
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

  const sessionId =
    input.sessionId ?? randomUUID().replace(/-/g, "").slice(0, 12);
  const threadId = randomUUID().replace(/-/g, "").slice(0, 12);
  const threadRef = (input.threadRef ??
    `web:S${sessionId}:T${threadId}`) as ThreadRef;

  const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  const cp = new CpClient({ baseUrl, internalToken });

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

      // First frame: tells the client which threadRef the server settled on
      // (it may have minted a fresh one if the request omitted threadRef).
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
            // Detached/workflow runs keep going on the thread SSE bus —
            // the inline stream is done either way.
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
