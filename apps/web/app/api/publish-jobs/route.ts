import { z } from "zod";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { CHANNELS, PUBLISH_JOB_STATUSES } from "@marketing/shared-types";
import { withAudit } from "@/lib/audit";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson, PublishGateError } from "@/lib/http";
import { enqueuePublish } from "@/lib/publish-queue";

/**
 * GET /api/publish-jobs
 * List publish jobs. Filterable by contentId, status, channel.
 */
export async function GET(request: Request) {
  try {
    const isInternalCall = isInternal(request);
    if (!isInternalCall) {
      await getRequestActor();
    }

    const url = new URL(request.url);
    const contentId = url.searchParams.get("contentId");
    const status = url.searchParams.get("status");
    const channel = url.searchParams.get("channel");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

    const db = getDb();
    const conditions = [];

    if (contentId) {
      conditions.push(eq(schema.publishJobs.contentId, contentId));
    }
    if (status && PUBLISH_JOB_STATUSES.includes(status as (typeof PUBLISH_JOB_STATUSES)[number])) {
      conditions.push(eq(schema.publishJobs.status, status as (typeof PUBLISH_JOB_STATUSES)[number]));
    }
    if (channel && CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
      conditions.push(eq(schema.publishJobs.channel, channel as (typeof CHANNELS)[number]));
    }

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(schema.publishJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.publishJobs.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.publishJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined),
    ]);

    const total = countResult[0]?.total ?? 0;
    return Response.json({ items: rows, total, limit, offset });
  } catch (err) {
    return errorResponse(err);
  }
}

const Enqueue = z.object({
  contentId: z.string().uuid(),
  channel: z.enum(CHANNELS),
  scheduledAt: z.string().datetime().optional(),
  threadRef: z.string().optional(),
  // Test-mode publishes flow through the queue but the distributor short-circuits
  // them — no real LinkedIn / X / email API calls. Driven by the admin test-chat.
  // Also auto-set when threadRef starts with `web:`.
  mode: z.enum(["live", "test"]).optional(),
});

// The Phase 1 invariant: this handler refuses to enqueue a publish job for
// content that isn't approved. The DB also has a BEFORE INSERT trigger that
// enforces the same rule (belt-and-suspenders, plan §9).
export async function POST(request: Request) {
  try {
    const actor = isInternal(request)
      ? { id: null, kind: "agent" as const }
      : await getRequestActor();
    const input = await parseJson(request, Enqueue);
    const db = getDb();

    const [content] = await db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, input.contentId))
      .limit(1);
    if (!content) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (content.status !== "approved" && content.status !== "scheduled") {
      throw new PublishGateError(
        `content ${input.contentId} is ${content.status}, expected approved`,
      );
    }

    // 24-hour republish guard: refuse if same content was already successfully
    // published to the same channel within the last 24 hours.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recentJob] = await db
      .select({ id: schema.publishJobs.id })
      .from(schema.publishJobs)
      .where(
        and(
          eq(schema.publishJobs.contentId, input.contentId),
          eq(schema.publishJobs.channel, input.channel),
          eq(schema.publishJobs.status, "succeeded"),
          gte(schema.publishJobs.createdAt, since),
        ),
      )
      .limit(1);
    if (recentJob) {
      return Response.json(
        { error: "republish_too_soon", message: "Same content was already published to this channel within 24 hours" },
        { status: 409 },
      );
    }

    const created = await withAudit(
      { db, actor, action: "publish_job.create", entityType: "publish_jobs" },
      async () => null,
      async () => {
        const mode =
          input.mode ?? (input.threadRef?.startsWith("web:") ? "test" : "live");
        const [row] = await db
          .insert(schema.publishJobs)
          .values({
            workspaceId: content.workspaceId,
            contentId: input.contentId,
            channel: input.channel,
            scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
            threadRef: input.threadRef ?? null,
            mode,
            requestedBy: actor.id ?? null,
          })
          .returning();
        // Bump content -> scheduled so subsequent enqueue attempts are
        // visible in the UI; transition is approved -> scheduled.
        if (content.status === "approved") {
          await db
            .update(schema.contentItems)
            .set({
              status: "scheduled",
              scheduledFor: input.scheduledAt
                ? new Date(input.scheduledAt)
                : new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.contentItems.id, input.contentId));
        }
        return row!;
      },
    );
    // Best-effort enqueue. publish_jobs row exists either way; a future poller
    // will pick up `queued` rows if Redis was down at insert time.
    const enqueueResult = await enqueuePublish(
      {
        publishJobId: created.id,
        contentId: created.contentId,
        workspaceId: created.workspaceId,
        channel: created.channel,
        threadRef: created.threadRef ?? undefined,
        mode: created.mode,
      },
      input.scheduledAt
        ? { delayMs: Math.max(0, new Date(input.scheduledAt).getTime() - Date.now()) }
        : undefined,
    );
    return Response.json({ ...created, enqueue: enqueueResult }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
