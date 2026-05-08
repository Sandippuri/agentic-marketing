import { errorResponse } from "@/lib/http";
import { getRequestActor } from "@/lib/auth";
import {
  subscribeWebThreadEvents,
  type WebThreadEvent,
} from "@/lib/chat/web-bus";

// SSE stream for test-chat. Phase 4 cutover: legacy proxy to apps/manager
// removed. Subscribes directly to the in-process bus and emits events.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await getRequestActor();
    const url = new URL(request.url);
    const threadRef = url.searchParams.get("threadRef");
    if (!threadRef || !threadRef.startsWith("web:")) {
      return Response.json(
        { error: "threadRef required (web:...)" },
        { status: 400 },
      );
    }
    return inProcessStream(threadRef);
  } catch (err) {
    return errorResponse(err);
  }
}

function inProcessStream(threadRef: string): Response {
  const encoder = new TextEncoder();
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: open\ndata: ${JSON.stringify({ threadRef })}\n\n`,
        ),
      );

      const onEvent = (event: WebThreadEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Stream already closed.
        }
      };
      const unsubscribe = subscribeWebThreadEvents(threadRef, onEvent);

      // 25s heartbeat so proxies don't time the connection out.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // Stream already closed.
        }
      }, 25_000);

      teardown = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      teardown?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
