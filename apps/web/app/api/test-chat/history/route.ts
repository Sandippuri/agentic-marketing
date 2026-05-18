// GET /api/test-chat/history?threadRef=...&format=ui|text
//
// Returns the persisted chat history for a thread so the Assistant UI can
// rehydrate after navigation / refresh.
//
//   format=text (default) → { history: [{ role, content }] }
//                            used by the legacy campaign-chat surface
//   format=ui              → { messages: Message[] }
//                            used by the rewritten Assistant page (useChat
//                            seeds `initialMessages` from this)

import { getRequestActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import {
  getHistoryStore,
  getUiHistoryStore,
} from "@/lib/chat/history-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await getRequestActor();
    const url = new URL(request.url);
    const threadRef = url.searchParams.get("threadRef");
    if (!threadRef) {
      return Response.json({ error: "threadRef required" }, { status: 400 });
    }
    const format = url.searchParams.get("format") ?? "text";

    if (format === "ui") {
      const messages = await getUiHistoryStore().get(threadRef);
      return Response.json({ messages });
    }

    const history = await getHistoryStore().get(threadRef);
    return Response.json({ history });
  } catch (err) {
    return errorResponse(err);
  }
}
