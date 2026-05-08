/**
 * GET    /api/goals/[id] — campaign + goal state + recent events
 * PATCH  /api/goals/[id] — halt or resume (sets loop_status)
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getRequestActor } from "@/lib/auth";
import { errorResponse, parseJson } from "@/lib/http";
import { listEvents } from "@/lib/goals/event-log";

export const dynamic = "force-dynamic";

const Patch = z.object({
  action: z.enum(["halt", "resume"]),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await getRequestActor();
    const { id } = await params;
    const db = getDb();
    const [campaign] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, id))
      .limit(1);
    if (!campaign) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const events = await listEvents(id, { limit: 100 });
    return Response.json({ campaign, events });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await getRequestActor();
    const { id } = await params;
    const input = await parseJson(request, Patch);
    const db = getDb();
    const next =
      input.action === "halt"
        ? "halted"
        : ("planning" as const);
    await db
      .update(schema.campaigns)
      .set({ loopStatus: next, lastIterationAt: new Date() })
      .where(eq(schema.campaigns.id, id));
    return Response.json({ ok: true, loopStatus: next });
  } catch (err) {
    return errorResponse(err);
  }
}
