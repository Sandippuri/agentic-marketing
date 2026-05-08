import { z } from "zod";
import { errorResponse, parseJson } from "@/lib/http";
import { assertInternal } from "@/lib/internal-auth";
import { publishWebThreadEvent } from "@/lib/chat/web-bus";
import pino from "pino";

const log = pino({ name: "thread-notify" });

const Notify = z
  .object({
    threadRef: z.string(),
    message: z.string().optional(),
    card: z.unknown().optional(),
  })
  .refine((v) => v.message !== undefined || v.card !== undefined, {
    message: "either message or card is required",
  });

// Internal-only endpoint. Sub-agents call this after a publish or sub-agent
// step. Phase 4 cutover: in-process delivery for web threads is the only
// path; Slack/Discord delivery comes back online in Phase 5 via dedicated
// /api/slack/events + /api/discord/interactions routes.
export async function POST(request: Request) {
  try {
    assertInternal(request);
    const input = await parseJson(request, Notify);

    if (input.threadRef.startsWith("web:")) {
      publishWebThreadEvent(input.threadRef, buildEvent(input));
      return Response.json({ ok: true, delivered: "in-process" });
    }

    log.warn(
      { threadRef: input.threadRef },
      "non-web threadRef received; Slack/Discord delivery is gated on Phase 5 wiring",
    );
    return Response.json({ ok: true, delivered: "dropped" });
  } catch (err) {
    return errorResponse(err);
  }
}

function buildEvent(input: {
  message?: string;
  card?: unknown;
}): import("@/lib/chat/web-bus").WebThreadEvent {
  if (input.card !== undefined) {
    return { kind: "approval_card", card: input.card };
  }
  return { kind: "message", text: input.message ?? "" };
}
