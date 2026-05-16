// Workspace-scoped read tools for the chat orchestrator. The orchestrator
// previously read from the Control Plane HTTP client over an internal token,
// which hard-pinned every call to the Legacy workspace and made the chat
// blind to per-tenant data.
//
// These tools bypass the HTTP layer and hit Postgres directly, filtering by
// the caller's `ctx.workspaceId`. Mutations still flow through the existing
// CP client so audit + workflow plumbing is unchanged.

import { tool } from "ai";
import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { BRAND_MEMORY_SLUGS, BRAND_MEMORY_TITLES } from "@marketing/shared-types";

export function buildWorkspaceTools({ workspaceId }: { workspaceId: string }) {
  const db = getDb();

  return {
    list_campaigns: tool({
      description:
        "List campaigns in this workspace. Use before referencing or routing to a specific campaign.",
      parameters: z.object({
        status: z
          .enum(["draft", "active", "paused", "completed", "archived"])
          .optional(),
        phase: z.enum(["buildup", "launch", "post_launch"]).optional(),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      execute: async ({ status, phase, limit }) => {
        const conds = [eq(schema.campaigns.workspaceId, workspaceId)];
        if (status) conds.push(eq(schema.campaigns.status, status));
        if (phase) conds.push(eq(schema.campaigns.phase, phase));
        const rows = await db
          .select({
            id: schema.campaigns.id,
            slug: schema.campaigns.slug,
            name: schema.campaigns.name,
            phase: schema.campaigns.phase,
            status: schema.campaigns.status,
            createdAt: schema.campaigns.createdAt,
          })
          .from(schema.campaigns)
          .where(and(...conds))
          .orderBy(desc(schema.campaigns.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          phase: r.phase,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    }),

    get_campaign: tool({
      description:
        "Fetch one campaign by id or slug, including the strategist brief and calendar.",
      parameters: z.object({
        idOrSlug: z.string().describe("Campaign id (uuid) or slug"),
      }),
      execute: async ({ idOrSlug }) => {
        const looksLikeUuid = /^[0-9a-f]{8}-/i.test(idOrSlug);
        const [row] = await db
          .select()
          .from(schema.campaigns)
          .where(
            and(
              eq(schema.campaigns.workspaceId, workspaceId),
              looksLikeUuid
                ? eq(schema.campaigns.id, idOrSlug)
                : eq(schema.campaigns.slug, idOrSlug),
            ),
          )
          .limit(1);
        if (!row) return { error: "not_found" };
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          phase: row.phase,
          status: row.status,
          briefMd: row.briefMd,
          calendarJson: row.calendarJson,
          createdAt: row.createdAt.toISOString(),
        };
      },
    }),

    list_content: tool({
      description:
        "List content items (drafts and posts). Optionally scope by campaign or status.",
      parameters: z.object({
        campaignId: z.string().optional(),
        status: z
          .enum([
            "draft",
            "in_review",
            "approved",
            "scheduled",
            "published",
            "retracted",
          ])
          .optional(),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      execute: async ({ campaignId, status, limit }) => {
        const conds = [eq(schema.contentItems.workspaceId, workspaceId)];
        if (campaignId)
          conds.push(eq(schema.contentItems.campaignId, campaignId));
        if (status) conds.push(eq(schema.contentItems.status, status));
        const rows = await db
          .select({
            id: schema.contentItems.id,
            campaignId: schema.contentItems.campaignId,
            title: schema.contentItems.title,
            type: schema.contentItems.type,
            stage: schema.contentItems.stage,
            status: schema.contentItems.status,
            scheduledFor: schema.contentItems.scheduledFor,
            publishedAt: schema.contentItems.publishedAt,
            createdAt: schema.contentItems.createdAt,
          })
          .from(schema.contentItems)
          .where(and(...conds))
          .orderBy(desc(schema.contentItems.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          campaignId: r.campaignId,
          title: r.title,
          type: r.type,
          stage: r.stage,
          status: r.status,
          scheduledFor: r.scheduledFor?.toISOString() ?? null,
          publishedAt: r.publishedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    }),

    get_content: tool({
      description:
        "Fetch one content item by id with its full body (markdown). Use when the user asks to read a draft or post.",
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const [row] = await db
          .select()
          .from(schema.contentItems)
          .where(
            and(
              eq(schema.contentItems.workspaceId, workspaceId),
              eq(schema.contentItems.id, id),
            ),
          )
          .limit(1);
        if (!row) return { error: "not_found" };
        return {
          id: row.id,
          campaignId: row.campaignId,
          title: row.title,
          type: row.type,
          stage: row.stage,
          status: row.status,
          bodyMd: row.bodyMd,
          scheduledFor: row.scheduledFor?.toISOString() ?? null,
          publishedAt: row.publishedAt?.toISOString() ?? null,
          publishedUrl: row.publishedUrl,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      },
    }),

    list_publish_jobs: tool({
      description:
        "List publish jobs in this workspace. Useful for status checks and stuck-job diagnostics.",
      parameters: z.object({
        contentId: z.string().optional(),
        status: z
          .enum(["queued", "running", "succeeded", "failed", "cancelled"])
          .optional(),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      execute: async ({ contentId, status, limit }) => {
        const conds = [eq(schema.publishJobs.workspaceId, workspaceId)];
        if (contentId) conds.push(eq(schema.publishJobs.contentId, contentId));
        if (status) conds.push(eq(schema.publishJobs.status, status));
        const rows = await db
          .select({
            id: schema.publishJobs.id,
            contentId: schema.publishJobs.contentId,
            channel: schema.publishJobs.channel,
            status: schema.publishJobs.status,
            externalUrl: schema.publishJobs.externalUrl,
            error: schema.publishJobs.error,
            scheduledAt: schema.publishJobs.scheduledAt,
            createdAt: schema.publishJobs.createdAt,
          })
          .from(schema.publishJobs)
          .where(and(...conds))
          .orderBy(desc(schema.publishJobs.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          contentId: r.contentId,
          channel: r.channel,
          status: r.status,
          externalUrl: r.externalUrl,
          error: r.error,
          scheduledAt: r.scheduledAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    }),

    list_approvals: tool({
      description:
        "List approval rows in this workspace. By default returns pending (un-decided) approvals only.",
      parameters: z.object({
        decided: z
          .boolean()
          .optional()
          .describe(
            "false (default) for pending only; true to include decided approvals.",
          ),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      execute: async ({ decided, limit }) => {
        const conds = [eq(schema.approvals.workspaceId, workspaceId)];
        if (!decided) conds.push(isNull(schema.approvals.decision));
        // Join content for human-readable titles.
        const rows = await db
          .select({
            id: schema.approvals.id,
            contentId: schema.approvals.contentId,
            decision: schema.approvals.decision,
            requestedAt: schema.approvals.requestedAt,
            decidedAt: schema.approvals.decidedAt,
            reason: schema.approvals.reason,
            contentTitle: schema.contentItems.title,
            contentType: schema.contentItems.type,
            contentStage: schema.contentItems.stage,
          })
          .from(schema.approvals)
          .innerJoin(
            schema.contentItems,
            eq(schema.contentItems.id, schema.approvals.contentId),
          )
          .where(and(...conds))
          .orderBy(desc(schema.approvals.requestedAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          contentId: r.contentId,
          contentTitle: r.contentTitle,
          contentType: r.contentType,
          contentStage: r.contentStage,
          decision: r.decision,
          requestedAt: r.requestedAt.toISOString(),
          decidedAt: r.decidedAt?.toISOString() ?? null,
          reason: r.reason,
        }));
      },
    }),

    get_brand_memory: tool({
      description:
        "Return the five brand-memory documents for this workspace (voice, ICP, visual, product state, positioning). Read these before drafting any content.",
      parameters: z.object({}),
      execute: async () => {
        const rows = await db
          .select()
          .from(schema.brandMemory)
          .where(
            and(
              eq(schema.brandMemory.workspaceId, workspaceId),
              isNull(schema.brandMemory.campaignId),
            ),
          );
        const bySlug = new Map(rows.map((r) => [r.slug, r]));
        return BRAND_MEMORY_SLUGS.map((slug) => {
          const row = bySlug.get(slug);
          return {
            slug,
            title: row?.title ?? BRAND_MEMORY_TITLES[slug],
            body: row?.body ?? "",
            updatedAt: row?.updatedAt?.toISOString() ?? null,
            filled: !!row?.body?.trim(),
          };
        });
      },
    }),

    list_workflow_runs: tool({
      description:
        "List recent workflow runs for this workspace. Useful for run status, retry diagnostics, and engine selection questions.",
      parameters: z.object({
        status: z
          .enum(["queued", "running", "completed", "failed", "cancelled"])
          .optional(),
        kind: z
          .enum([
            "campaign",
            "single_post",
            "asset",
            "analysis",
            "publish",
            "research",
            "other",
          ])
          .optional(),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      execute: async ({ status, kind, limit }) => {
        const conds = [eq(schema.workflowRuns.workspaceId, workspaceId)];
        if (status) conds.push(eq(schema.workflowRuns.status, status));
        if (kind) conds.push(eq(schema.workflowRuns.kind, kind));
        const rows = await db
          .select({
            id: schema.workflowRuns.id,
            engine: schema.workflowRuns.engine,
            kind: schema.workflowRuns.kind,
            status: schema.workflowRuns.status,
            request: schema.workflowRuns.request,
            campaignId: schema.workflowRuns.campaignId,
            contentId: schema.workflowRuns.contentId,
            startedAt: schema.workflowRuns.startedAt,
            completedAt: schema.workflowRuns.completedAt,
            error: schema.workflowRuns.error,
          })
          .from(schema.workflowRuns)
          .where(and(...conds))
          .orderBy(desc(schema.workflowRuns.startedAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          engine: r.engine,
          kind: r.kind,
          status: r.status,
          request: r.request,
          campaignId: r.campaignId,
          contentId: r.contentId,
          startedAt: r.startedAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          error: r.error,
        }));
      },
    }),
  };
}

// Workspace-aware lookup helper for slash commands that need to resolve a
// human-typed campaign name to an id. Returns the closest match or null.
export async function resolveCampaign(
  workspaceId: string,
  needle: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  const db = getDb();
  const trimmed = needle.trim();
  if (!trimmed) return null;
  const looksLikeUuid = /^[0-9a-f]{8}-/i.test(trimmed);
  const [byExact] = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      slug: schema.campaigns.slug,
    })
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.workspaceId, workspaceId),
        looksLikeUuid
          ? eq(schema.campaigns.id, trimmed)
          : eq(schema.campaigns.slug, trimmed),
      ),
    )
    .limit(1);
  if (byExact) return byExact;
  // Fallback: case-insensitive name match.
  const all = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      slug: schema.campaigns.slug,
    })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.workspaceId, workspaceId));
  const lower = trimmed.toLowerCase();
  const hit =
    all.find((c) => c.name.toLowerCase() === lower) ??
    all.find((c) => c.name.toLowerCase().includes(lower)) ??
    all.find((c) => c.slug.toLowerCase().includes(lower));
  return hit ?? null;
}

// Silence the unused-import warning when inArray isn't needed; the API
// surface above only uses inArray for list_publish_jobs filtering paths in
// future revisions. Keep the import to make the next change cheap.
void inArray;
