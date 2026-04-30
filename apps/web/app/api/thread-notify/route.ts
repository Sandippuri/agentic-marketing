import { z } from "zod";
import { errorResponse, parseJson } from "@/lib/http";
import { assertInternal } from "@/lib/internal-auth";
import pino from "pino";

const log = pino({ name: "thread-notify" });

const Notify = z.object({
  threadRef: z.string(),
  message: z.string(),
});

// The Distributor calls this after a publish succeeds. This Route Handler
// forwards the message to the Manager's /forward-notify endpoint (where
// Slack/Discord credentials live). If the Manager URL is not set, we log and
// return 200 so the Distributor isn't penalised for a configuration gap.
export async function POST(request: Request) {
  try {
    assertInternal(request);
    const input = await parseJson(request, Notify);

    const managerUrl = process.env.MANAGER_BASE_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN ?? "";

    if (!managerUrl) {
      log.warn({ threadRef: input.threadRef }, "MANAGER_BASE_URL not set; thread-notify dropped");
      return Response.json({ ok: true, forwarded: false });
    }

    const res = await fetch(`${managerUrl}/forward-notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": internalToken,
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error({ status: res.status, body }, "Manager forward-notify failed");
      return Response.json({ ok: false, status: res.status }, { status: 502 });
    }

    log.info({ threadRef: input.threadRef }, "thread-notify forwarded to manager");
    return Response.json({ ok: true, forwarded: true });
  } catch (err) {
    return errorResponse(err);
  }
}
