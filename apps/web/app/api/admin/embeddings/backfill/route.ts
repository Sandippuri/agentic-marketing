/**
 * POST /api/admin/embeddings/backfill — re-embed `embeddings` rows whose
 * `model` does not match the currently-configured embedding model.
 *
 * Switching providers (e.g. OpenAI → Gemini) leaves old vectors in place but
 * the read side filters by `embeddings.model = <current>`, so they become
 * invisible to search. This route walks those orphaned rows in batches and
 * re-embeds them with the active provider so search works again.
 *
 * Re-uses each row's stored `text` column (populated at write time), so we
 * don't have to re-read the source document. Idempotent: a row already on the
 * current model is skipped.
 *
 * Body: { batchSize?: number = 50, sourceTypes?: string[] }
 * Response: { processed, updated, remaining, currentModel }
 *
 * GET / HEAD return the current pending count without doing work — useful for
 * the UI to show "N stale rows" before the user pulls the trigger.
 */
import { z } from "zod";
import { and, eq, ne, sql, inArray } from "drizzle-orm";
import { getDb, schema, embeddings } from "@marketing/db";
import { embedBatch, getEmbeddingConfig } from "@marketing/agents/kb";
import { getRequestActor } from "@/lib/auth";
import { isInternal } from "@/lib/internal-auth";
import { errorResponse, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    batchSize: z.number().int().min(1).max(200).optional().default(50),
    sourceTypes: z
      .array(z.enum(["content", "kb_chunk", "rejected_draft", "brand_doc"]))
      .optional(),
  })
  .optional();

type Counts = { stale: number; current: number; currentModel: string };

async function readCounts(): Promise<Counts> {
  const db = getDb();
  const { model } = await getEmbeddingConfig();
  const [row] = await db
    .select({
      stale: sql<number>`count(*) filter (where ${embeddings.model} <> ${model})::int`,
      current: sql<number>`count(*) filter (where ${embeddings.model} = ${model})::int`,
    })
    .from(embeddings);
  return {
    stale: row?.stale ?? 0,
    current: row?.current ?? 0,
    currentModel: model,
  };
}

export async function GET(request: Request) {
  try {
    if (!isInternal(request)) await getRequestActor();
    return Response.json(await readCounts());
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    if (!isInternal(request)) await getRequestActor();

    const input = (await parseJson(request, Body)) ?? {};
    const batchSize = input.batchSize ?? 50;
    const sourceTypes = input.sourceTypes;

    const db = getDb();
    const { model } = await getEmbeddingConfig();

    // Pull a batch of stale rows. Empty `text` rows are skipped — there's
    // nothing to re-embed from. Those would need to be re-ingested from
    // source via /api/kb/documents or the embed worker.
    const stale = await db
      .select({
        id: embeddings.id,
        text: embeddings.text,
        sourceType: embeddings.sourceType,
      })
      .from(embeddings)
      .where(
        and(
          ne(embeddings.model, model),
          sql`length(${embeddings.text}) > 0`,
          sourceTypes?.length
            ? inArray(embeddings.sourceType, sourceTypes)
            : sql`true`,
        ),
      )
      .limit(batchSize);

    if (stale.length === 0) {
      const counts = await readCounts();
      return Response.json({
        processed: 0,
        updated: 0,
        remaining: counts.stale,
        currentModel: counts.currentModel,
      });
    }

    const vectors = await embedBatch(stale.map((r) => r.text));
    if (vectors.length !== stale.length) {
      throw new Error(
        `embed mismatch: ${vectors.length} vectors for ${stale.length} rows`,
      );
    }

    let updated = 0;
    for (let i = 0; i < stale.length; i++) {
      const row = stale[i];
      const vec = vectors[i];
      if (!row || !vec) continue;
      await db
        .update(embeddings)
        .set({
          embedding: vec,
          model,
          embeddedAt: new Date(),
        })
        .where(eq(embeddings.id, row.id));
      updated++;
    }

    const counts = await readCounts();
    return Response.json({
      processed: stale.length,
      updated,
      remaining: counts.stale,
      currentModel: counts.currentModel,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
