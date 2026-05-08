import { z } from "zod";
import { randomUUID } from "node:crypto";
import { errorResponse, parseJson } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
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
    const input = await parseJson(request, Send);
    const userId = actor.id ?? "admin";

    return await handleInProcess({
      text: input.text,
      threadRef: input.threadRef,
      sessionId: input.sessionId,
      model: input.model,
      userId,
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
    threadRef,
    cp,
    model: input.model,
    campaignId: input.campaignId,
  });
  return Response.json({ reply, threadRef });
}
