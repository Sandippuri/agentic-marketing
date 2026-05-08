// /api/generation-jobs
//   GET   list jobs (?status=running|completed|failed&limit=&offset=)
//   POST  create a new job (internal-only — manager calls this when an
//         orchestrator turn is about to invoke its first sub-agent).
//
// Read access via authenticated session OR internal token; writes are
// internal-only (the manager is the sole producer).

import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getRequestActor } from "@/lib/auth";
import { assertInternal, isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

const GENERATION_JOB_STATUSES = ["running", "completed", "failed"] as const;
const GENERATION_JOB_KINDS = [
  "campaign",
  "single_post",
  "asset",
  "analysis",
  "publish",
  "other",
] as const;

export async function GET(request: Request) {
  try {
    if (!isInternal(request)) await getRequestActor();

    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

    const db = getDb();
    const conditions = [];
    if (status && (GENERATION_JOB_STATUSES as readonly string[]).includes(status)) {
      conditions.push(
        eq(
          schema.generationJobs.status,
          status as (typeof GENERATION_JOB_STATUSES)[number],
        ),
      );
    }

    const [rows, countRow] = await Promise.all([
      db
        .select()
        .from(schema.generationJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.generationJobs.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.generationJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined),
    ]);
    return Response.json({ items: rows, total: countRow[0]?.total ?? 0, limit, offset });
  } catch (err) {
    return errorResponse(err);
  }
}

const CreateGenerationJob = z.object({
  threadRef: z.string().optional(),
  userId: z.string().optional(),
  userMessage: z.string().min(1).max(10_000),
  kind: z.enum(GENERATION_JOB_KINDS).optional(),
});

export async function POST(request: Request) {
  try {
    assertInternal(request);
    const input = await parseJson(request, CreateGenerationJob);
    const db = getDb();
    const [row] = await db
      .insert(schema.generationJobs)
      .values({
        threadRef: input.threadRef ?? null,
        userId: input.userId ?? null,
        userMessage: input.userMessage,
        kind: input.kind ?? "other",
        status: "running",
      })
      .returning({ id: schema.generationJobs.id });
    return Response.json({ id: row!.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
