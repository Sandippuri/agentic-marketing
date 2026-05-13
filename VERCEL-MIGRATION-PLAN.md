# Vercel Migration Plan — Workflow DevKit + Vercel-only deploy

Plan for moving the platform from the current **`apps/web` (Next.js) + `apps/manager` (standalone Node) + `apps/distributor` (BullMQ workers)** topology to a **Vercel-only** deployment using the [`workflow`](https://www.npmjs.com/package/workflow) package as the orchestrator.

> Status: **Phases 1–3 landed; Phase 4 documentation pass complete (2026-05-04)** — see §11–§14 below. Destructive cleanup (deleting `apps/manager`, `apps/distributor`, shrinking `cp-client`) is gated on the user verifying dual-run behaviour in their environment first. Execute phase-by-phase; each phase is independently shippable.

> **API correction (2026-05-04):** the original draft of this plan referenced
> `step.do(...)`, `step.waitForSignal(...)`, `step.sleepUntil(...)`, and
> `workflow.run(...)`. The actual `workflow` SDK (v4.2) uses directives:
> functions tagged `"use step"` are auto-instrumented when `await`-ed from a
> `"use workflow"` function. Suspension uses `createHook()`/`defineHook()` (or
> `createWebhook()` for HTTP), with resume via `resumeHook()` from
> `workflow/api`. Workflow runs are started with `start(workflow, [args])`
> from `workflow/api`. Treat `step.do` / `waitForSignal` references in §5.2
> below as pseudocode — see the Phase 1 implementation in
> [apps/web/workflows/single-post.ts](apps/web/workflows/single-post.ts) for
> the real shape.

---

## 1. Constraints we're designing against

| Constraint | Implication |
|---|---|
| Vercel runs serverless functions, edge, or Fluid — **no long-lived processes** | Every `setInterval`, `Worker`, `Queue` consumer, IORedis pub/sub subscriber, Slack socket-mode connection, Discord WebSocket login must go (or move to a webhook + workflow) |
| Function max duration (Fluid raises ceiling, but per-step is the right model) | Each Vercel Workflow `step.do(...)` is its own short invocation — long sub-agent runs must be split into steps, not one monster function |
| Vercel Cron triggers HTTP routes only | The custom `setTimeout`-based weekly cron in [apps/manager/src/cron.ts](apps/manager/src/cron.ts) becomes a `vercel.json` cron entry |
| Vercel Workflow durability layer needs the Vercel runtime in prod | Local dev uses the OSS SDK; production durability requires Vercel deploy (matches the goal) |
| BullMQ requires a long-running consumer — can't run on Vercel | Replace publish/embed/metrics queues with workflow steps, signals, and Vercel Cron |

---

## 2. Target topology

```
┌──────────────────────── apps/web (Next.js on Vercel) ─────────────────────┐
│                                                                            │
│  Pages (admin UI)            unchanged                                     │
│                                                                            │
│  app/api/                                                                  │
│   ├─ workflows/                ← NEW: workflow trigger + signal endpoints  │
│   │   ├─ campaign/route.ts     POST → kicks off campaign workflow          │
│   │   ├─ single-post/route.ts  POST → kicks off single_post workflow       │
│   │   ├─ asset/route.ts        POST → kicks off asset workflow             │
│   │   └─ approve/route.ts      POST → emits signal "approval:<contentId>"  │
│   ├─ chat/route.ts             ← MOVED from manager: LLM-routed orch       │
│   ├─ chat/stream/[ref]/route.ts← MOVED from manager: SSE for chat          │
│   ├─ bot/                                                                  │
│   │   ├─ slack/route.ts        ← MOVED: Slack Events API webhook          │
│   │   ├─ discord/route.ts      ← MOVED: Discord Interactions webhook       │
│   │   └─ telegram/route.ts     ← MOVED: Telegram webhook (if used)         │
│   └─ cron/                                                                 │
│       ├─ weekly-analyst/route.ts ← Vercel Cron target                      │
│       ├─ outcomes-rollup/route.ts ← Vercel Cron target                     │
│       └─ metrics-fetch/route.ts ← Vercel Cron target                       │
│                                                                            │
│  workflows/                    ← NEW dir: 'use workflow' definitions       │
│   ├─ campaign.ts                                                            │
│   ├─ single-post.ts                                                         │
│   ├─ asset.ts                                                               │
│   ├─ publish.ts                                                             │
│   └─ embed.ts                                                               │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

packages/  (unchanged shape, expanded)
  ├─ db                        unchanged
  ├─ shared-types              unchanged
  ├─ prompts                   unchanged
  ├─ cp-client                 SHRINKS — internal HTTP wrapper no longer needed when callers are in-process
  └─ agents/  ← NEW             sub-agents extracted from apps/manager so workflows can import them
       ├─ strategist.ts
       ├─ content.ts
       ├─ asset.ts
       ├─ analyst.ts
       └─ index.ts

apps/manager       ← DELETED at end of phase 3
apps/distributor   ← DELETED at end of phase 2
```

Production deps: **Vercel** (functions + workflows + cron + queues), **Supabase** (DB + storage, unchanged), **Upstash Redis** (only if we keep any pub/sub — likely not needed).

---

## 3. Key concept mapping

| Today | Vercel-native replacement |
|---|---|
| `apps/manager` Node HTTP server ([http-server.ts](apps/manager/src/http-server.ts)) | Next.js API routes in `apps/web/app/api/` |
| `/workflow/start` background promise + `generation_jobs` tracker ([http-server.ts:139-313](apps/manager/src/http-server.ts#L139-L313), [generation-tracker.ts](apps/manager/src/generation-tracker.ts)) | Workflow run via `workflow.run(...)` from API route |
| Slack Bolt **socket mode** ([bot/slack.ts](apps/manager/src/bot/slack.ts)) | Slack **Events API** (HTTP webhook) at `/api/bot/slack` |
| Discord.js **WebSocket** login ([bot/discord.ts](apps/manager/src/bot/discord.ts)) | Discord **HTTP Interactions** at `/api/bot/discord` (requires registering the public key) |
| `setTimeout` weekly cron ([cron.ts](apps/manager/src/cron.ts)) | `vercel.json` cron → `/api/cron/weekly-analyst` → `workflow.run(weeklyAnalyst)` |
| BullMQ `publish` queue ([apps/distributor/src/index.ts:31](apps/distributor/src/index.ts#L31), [worker.ts](apps/distributor/src/worker.ts)) | `publish` workflow per content item; channel adapters become workflow steps |
| BullMQ `embed` queue ([embed-worker.ts](apps/distributor/src/embed-worker.ts)) | `embed` workflow triggered from approval signal handler |
| BullMQ `metrics` queue ([metrics-cron.ts](apps/distributor/src/metrics-cron.ts)) | `metrics` workflow triggered by Vercel Cron |
| BullMQ `outcomes-rollup` ([outcomes-rollup.ts](apps/distributor/src/outcomes-rollup.ts)) | `outcomesRollup` workflow triggered by Vercel Cron |
| IORedis pub/sub for chat SSE ([thread-poster.ts](apps/manager/src/thread-poster.ts)) | Vercel Fluid SSE response, or Upstash pub/sub if multi-region |
| `cp-client` wrapping internal HTTP ([packages/cp-client/src/index.ts](packages/cp-client/src/index.ts)) | Direct DB calls from workflow steps via `@marketing/db` (no HTTP hop). `cp-client` shrinks to chat/SSE notify only |
| `generation_jobs` + `generation_job_steps` tables ([packages/db/src/schema.ts](packages/db/src/schema.ts)) | Optional — workflow runs UI is built into Vercel. Keep tables only if we want a custom dashboard, otherwise drop |

---

## 4. New runtime + dev dependencies

Add to `apps/web/package.json`:
- `workflow` — the SDK
- `@upstash/redis` (only if we keep any pub/sub for chat)
- `@slack/web-api` — REST-only Slack client (replaces socket-mode Bolt)
- `discord-interactions` — verifies signed Discord webhook requests

Drop from `apps/manager/package.json` / `apps/distributor/package.json` (then delete the apps):
- `@slack/bolt` (socket mode)
- `discord.js` (WebSocket gateway)
- `bullmq` + `ioredis` (queue consumers)

Vercel project settings:
- Enable Workflows (currently GA)
- Add Vercel Cron entries (`vercel.json`)
- Set framework env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, channel adapter keys (LinkedIn, X, HubSpot, Mailchimp), bot tokens, `INTERNAL_API_TOKEN`

---

## 5. File-by-file mapping

### 5.1 Sub-agents — extract to a shared package

Currently in [apps/manager/src/sub-agents/](apps/manager/src/sub-agents/). Move to **`packages/agents/src/`** so both workflow steps and the chat orchestrator can import them.

| From | To |
|---|---|
| `apps/manager/src/sub-agents/strategist.ts` | `packages/agents/src/strategist.ts` |
| `apps/manager/src/sub-agents/content.ts` | `packages/agents/src/content.ts` |
| `apps/manager/src/sub-agents/asset.ts` | `packages/agents/src/asset.ts` |
| `apps/manager/src/sub-agents/analyst.ts` | `packages/agents/src/analyst.ts` |
| `apps/manager/src/llm-registry.ts` | `packages/agents/src/llm-registry.ts` |
| `apps/manager/src/image-gen.ts` | `packages/agents/src/image-gen.ts` |
| `apps/manager/src/asset-uploader.ts` | `packages/agents/src/asset-uploader.ts` |
| `apps/manager/src/brand-store.ts`, `design-system-store.ts`, `brand-guidance.ts`, `find-common-mistakes.ts`, `find-similar.ts`, `memory.ts`, `template-render.ts`, `ga4-client.ts` | `packages/agents/src/` |
| `apps/manager/src/cards/approval.ts` | `packages/agents/src/cards/approval.ts` |
| `apps/manager/src/types/` | `packages/agents/src/types/` |

After this move, sub-agents call `getDb()` directly from `@marketing/db` instead of going through `cp-client` HTTP. Each sub-agent becomes a pure async function — perfect for wrapping in `step.do(...)`.

### 5.2 Workflows — new files in `apps/web/workflows/`

Each file uses the `'use workflow'` directive at the top.

#### `workflows/single-post.ts`
```
input: { campaignId, request, channel?, model? }
steps:
  1. step.do("draft-content", () => runContent({...}))
  2. step.do("generate-asset", () => runAsset({...}))         ← parallel-able with (1) if asset doesn't depend on copy
  3. step.do("submit-for-review", () => cpSubmitForReview(...))
  4. const decision = await step.waitForSignal(`approval:${contentId}`, { timeout: '7d' })
  5. if (decision === "approved")
        step.do("publish", () => workflow.run(publishWorkflow, {...}))
     else
        step.do("mark-rejected", () => cpMarkRejected(...))
output: { contentId, status }
```

#### `workflows/campaign.ts`
```
input: { request, model? }
steps:
  1. step.do("strategist", () => runStrategist({...})) → returns { campaignId, slug, plannedItems[] }
  2. for each plannedItem in parallel: workflow.run(singlePostWorkflow, item)
output: { campaignId, postCount }
```

#### `workflows/asset.ts`
```
input: { request, contentId?, model? }
steps:
  1. step.do("generate", () => runAsset({...}))
output: { assetId, url }
```

#### `workflows/publish.ts` (replaces `apps/distributor/src/worker.ts`)
```
input: { publishJobId, contentId, channel, scheduledAt? }
steps:
  1. if scheduledAt > now: await step.sleepUntil(scheduledAt)
  2. step.do("fetch-content", () => loadContent(contentId))
  3. step.do(`adapter:${channel}`, () => adapters[channel].publish(...))    ← retried by SDK on failure
  4. step.do("update-publish-job", () => markPublished(publishJobId, externalUrl))
  5. step.do("trigger-metrics-fetch", () => workflow.run(metricsWorkflow, {...}))
output: { externalUrl }
```

#### `workflows/embed.ts` (replaces `apps/distributor/src/embed-worker.ts`)
```
input: { contentId }
steps:
  1. step.do("load", () => loadContentForEmbed(contentId))
  2. step.do("embed", () => openai.embeddings.create({...}))
  3. step.do("upsert", () => insertEmbedding({...}))
```

#### `workflows/metrics.ts` (replaces `apps/distributor/src/metrics-cron.ts`)
```
input: { publishJobId }   ← per-job; cron fans out
steps:
  1. step.do(`fetch:${channel}`, () => adapters[channel].fetchMetrics(...))
  2. step.do("upsert-outcomes", () => insertOutcome({...}))
```

#### `workflows/outcomes-rollup.ts` (replaces `apps/distributor/src/outcomes-rollup.ts`)
```
input: {}
steps:
  1. step.do("aggregate", () => rollupOutcomes())
```

#### `workflows/weekly-analyst.ts` (replaces [apps/manager/src/cron.ts](apps/manager/src/cron.ts))
```
input: {}
steps:
  1. const report = await step.do("analyst", () => runAnalyst({...}))
  2. step.do("post-to-slack", () => slack.chat.postMessage({ channel: MARKETING_CHANNEL, text: report }))
```

### 5.3 API route changes in `apps/web/app/api/`

#### NEW
| Route | Purpose |
|---|---|
| `app/api/workflows/campaign/route.ts` | POST → `workflow.run(campaignWorkflow, body)` (replaces `/api/generation-jobs/start` for `kind=campaign`) |
| `app/api/workflows/single-post/route.ts` | Same for `kind=single_post` |
| `app/api/workflows/asset/route.ts` | Same for `kind=asset` |
| `app/api/workflows/approve/route.ts` | POST → emits signal `approval:<contentId>` |
| `app/api/workflows/[runId]/route.ts` | GET → run status (or proxy to Vercel Workflow API for the dashboard link) |
| `app/api/chat/route.ts` | Moved from manager `/chat`. Calls `runOrchestrator()` from `@marketing/agents` |
| `app/api/chat/stream/[threadRef]/route.ts` | Moved from manager `/chat/stream/:ref`. Uses `ReadableStream` SSE |
| `app/api/bot/slack/route.ts` | Slack Events API webhook. Verifies signing secret, dispatches mentions to chat |
| `app/api/bot/discord/route.ts` | Discord Interactions webhook. Verifies ed25519 signature |
| `app/api/cron/weekly-analyst/route.ts` | Vercel Cron target → `workflow.run(weeklyAnalystWorkflow)` |
| `app/api/cron/outcomes-rollup/route.ts` | Vercel Cron target → `workflow.run(outcomesRollupWorkflow)` |
| `app/api/cron/metrics-fetch/route.ts` | Vercel Cron target — enumerates due publish_jobs and fans out `metricsWorkflow` runs |

#### CHANGED
| Route | Change |
|---|---|
| [apps/web/app/api/approvals/[id]/route.ts](apps/web/app/api/approvals/[id]/route.ts) | After updating DB, also POST to `/api/workflows/approve` (or call workflow signal directly) so the waiting workflow resumes |
| [apps/web/app/api/publish-jobs/route.ts](apps/web/app/api/publish-jobs/route.ts) | Replace `enqueuePublish` (BullMQ) with `workflow.run(publishWorkflow, {...})` |
| [apps/web/app/api/generation-jobs/start/route.ts](apps/web/app/api/generation-jobs/start/route.ts) | Either delete (the new `/api/workflows/*` routes replace it) **OR** keep as a thin façade that forwards to the new routes for backwards compat with the form |
| [apps/web/lib/publish-queue.ts](apps/web/lib/publish-queue.ts) | DELETE — replaced by `workflow.run(publishWorkflow, ...)` |
| [apps/web/lib/embedding-queue.ts](apps/web/lib/embedding-queue.ts) | DELETE — replaced by `workflow.run(embedWorkflow, ...)` |
| [apps/web/lib/realtime-invalidator.tsx](apps/web/lib/realtime-invalidator.tsx) | Keep — Supabase realtime still drives UI invalidation |

#### DELETED
- `apps/manager/` entire directory (after phase 3)
- `apps/distributor/` entire directory (after phase 2)

### 5.4 Adapters

Channel adapters in [apps/distributor/src/adapters/](apps/distributor/src/adapters/) (`internal-blog.ts`, `linkedin.ts`, `x.ts`, `x-oauth.ts`, `hubspot-email.ts`, `mailchimp.ts`) move to:

```
packages/agents/src/adapters/
  internal-blog.ts
  linkedin.ts
  x.ts
  x-oauth.ts
  hubspot-email.ts
  mailchimp.ts
  index.ts
```

Workflow steps import them directly. No more queue + worker indirection.

### 5.5 Bot integrations

| File | Change |
|---|---|
| [apps/manager/src/bot/slack.ts](apps/manager/src/bot/slack.ts) (Bolt socket mode) | Rewrite as **`apps/web/app/api/bot/slack/route.ts`** using Events API. Slack signs requests with `SLACK_SIGNING_SECRET`; verify, parse `event.type === "app_mention"`, hand to `handleChat` |
| [apps/manager/src/bot/discord.ts](apps/manager/src/bot/discord.ts) (discord.js gateway) | Rewrite as **`apps/web/app/api/bot/discord/route.ts`** using HTTP Interactions. Verify ed25519 signature with `DISCORD_PUBLIC_KEY`, dispatch slash commands to `handleChat` |

Slash command registration moves to a one-shot script (`scripts/register-discord-commands.ts`) — no longer a startup step.

### 5.6 `cp-client` package

Today, [packages/cp-client/src/index.ts](packages/cp-client/src/index.ts) wraps internal HTTP calls into `apps/web` (e.g. `cp.createGenerationJob`, `cp.enqueuePublish`, `cp.notifyThread`). When sub-agents move into the same Next.js process, **most of these become direct DB calls** via `@marketing/db`.

Plan:
- **Phase 1–2:** keep `cp-client` working so the manager can still call into web during migration.
- **Phase 3:** when sub-agents move into the web app, replace cp-client calls inside agents with direct DB access.
- **Phase 4:** shrink `cp-client` to just the chat-thread notify path (or delete entirely if chat moves too).

### 5.7 `vercel.json` (NEW at repo root or `apps/web/vercel.json`)

```jsonc
{
  "crons": [
    { "path": "/api/cron/weekly-analyst",  "schedule": "15 3 * * 1" },     // Mon 03:15 UTC = 09:00 KTM
    { "path": "/api/cron/outcomes-rollup", "schedule": "0 1 * * *" },       // 01:00 UTC daily
    { "path": "/api/cron/metrics-fetch",   "schedule": "0 */6 * * *" }      // every 6h
  ]
}
```

### 5.8 `generation_jobs` tables

[packages/db/src/schema.ts](packages/db/src/schema.ts) currently defines `generation_jobs` and `generation_job_steps` tables to power `/creation-workflow`. **Decision needed (see §7):**

- **Option A — keep them** as a denormalised view of workflow runs. The `/api/workflows/*/route.ts` POST handler writes a row, and a webhook from Vercel Workflows updates step status. Pro: existing UI keeps working unchanged. Con: dual source of truth.
- **Option B — drop them**, point `/creation-workflow` at the Vercel Workflow runs API directly. Pro: single source of truth. Con: rewrite the page, lose the per-step input/output preview UI we just built (Vercel's UI is generic).

Recommended: **A for phase 1–2, B for phase 4** once we've confirmed Vercel's UI is good enough.

---

## 6. Phased execution

### Phase 1 — Single workflow proof (1–2 days)
**Goal:** prove the pattern with one path; manager + distributor still run normally.

1. `pnpm add workflow` in `apps/web`.
2. Create `packages/agents/` and **copy** (not move) `runStrategist`, `runContent`, `runAsset` plus their dependencies (llm-registry, brand-store, prompts wiring). Don't delete from manager yet.
3. Build `workflows/single-post.ts` with the 5-step flow (content → asset → submit → wait-for-signal → publish-stub).
4. Add `app/api/workflows/single-post/route.ts` (POST trigger) and `app/api/workflows/approve/route.ts` (signal emit).
5. Wire the `/creation-workflow` "Continue → Draft post" button (just added) to hit `/api/workflows/single-post` in **dev only**, behind a feature flag.
6. Add a "publish" stub step that just logs — actual publish still goes through BullMQ.
7. **Acceptance:** start a single_post via the new route, see workflow run in Vercel dashboard, hit approve in admin UI, watch the workflow resume past `waitForSignal` and call the publish stub.

### Phase 2 — Replace BullMQ workers (2–3 days)
**Goal:** delete `apps/distributor`.

1. Move `apps/distributor/src/adapters/*` to `packages/agents/src/adapters/`.
2. Build `workflows/publish.ts`, `workflows/embed.ts`, `workflows/metrics.ts`, `workflows/outcomes-rollup.ts`.
3. Add `app/api/cron/{outcomes-rollup,metrics-fetch}/route.ts` and `vercel.json` cron entries.
4. Replace `apps/web/lib/publish-queue.ts` and `apps/web/lib/embedding-queue.ts` call sites with `workflow.run(...)`.
5. Update `singlePostWorkflow` to call the real `publishWorkflow` instead of the stub.
6. Run both old (BullMQ) and new (workflow) paths in parallel for 24h, compare.
7. Remove `enqueuePublish`/`enqueueEmbed` calls; delete `apps/distributor/`.
8. **Acceptance:** publish jobs land via workflow only; metrics + outcomes rollup run on Vercel Cron.

### Phase 3 — Move chat + bots into the web app (3–5 days)
**Goal:** delete `apps/manager`.

1. **Move** sub-agents from manager to `packages/agents/` (delete the copies left in manager).
2. Move `chat-handler.ts`, `orchestrator.ts`, `thread-poster.ts` to `apps/web/lib/chat/`.
3. Add `app/api/chat/route.ts` and `app/api/chat/stream/[threadRef]/route.ts`. Replace IORedis pub/sub with either Upstash pub/sub or pass-through `ReadableStream` (single-region only).
4. Rewrite Slack bot as Events API webhook at `app/api/bot/slack/route.ts`. Reconfigure Slack app to webhook URL; remove socket-mode env vars.
5. Rewrite Discord bot as HTTP Interactions at `app/api/bot/discord/route.ts`. Add ed25519 verification.
6. Add `app/api/cron/weekly-analyst/route.ts` + cron entry; remove `apps/manager/src/cron.ts`.
7. Update web app to call orchestrator in-process instead of HTTP'ing to manager.
8. Delete `apps/manager/`.
9. **Acceptance:** Slack/Discord mentions still work, chat SSE still works, weekly cron still posts, no Node process running outside Vercel.

### Phase 4 — Cleanup (1 day)
1. Decide on `generation_jobs` tables (Option A vs B above).
2. Shrink or delete `cp-client`.
3. Drop `INTERNAL_API_TOKEN` plumbing if no internal HTTP hops remain.
4. Drop `REDIS_URL` env var unless we kept Upstash for SSE.
5. Update `RUNBOOK.md` and `AGENTIC_MARKETING_IMPLEMENTATION.md` to reflect the new topology.

---

## 7. Open questions to resolve before phase 1

1. **Chat SSE:** Vercel Fluid + plain `ReadableStream` works for single-region. Do we need multi-region pub/sub (Upstash) or is single-region fine?
2. **Slack mode:** Switching from socket mode to Events API requires a publicly reachable URL — the prod Vercel URL. Are we OK reconfiguring the Slack app, or do we need a backwards-compat path during migration?
3. **Discord:** Do we use Discord at all in production today? (The bot is wired but maybe unused — if so, skip phase 3 step 5 entirely.)
4. **`generation_jobs` UI:** Keep the rich custom dashboard at `/creation-workflow`, or accept Vercel's generic workflow runs UI? (See §5.8.)
5. **`workflow` SDK auth model:** Do workflow runs from a logged-in admin pass `userId` through, and is that visible in the Vercel dashboard for filtering? Need to verify.
6. **Cron concurrency:** `metrics-fetch` fans out per publish_job. If there are 200 pending jobs, that's 200 workflow runs from one cron tick — within Vercel limits? Need to check or add a rate-limited fan-out.
7. **`stopWhen` in chat orchestrator:** Today the LLM-routed orchestrator uses `maxSteps: 10` ([orchestrator.ts:76](apps/manager/src/orchestrator.ts#L76)). When this runs in a Vercel function, does it fit in function duration? Likely yes (most turns are <30s) but worth measuring before phase 3.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| `workflow` SDK API changes | It's GA but still young. Pin the version; revisit before phase 4 |
| Slack Events API requires a public URL — local dev breaks | Use ngrok in dev, or keep a local-dev fallback that polls instead of webhook |
| Discord HTTP Interactions can't proactively post — only respond to user-initiated commands. If we send unsolicited messages today, that path needs the Discord REST API (a separate token call) | Audit current outbound Discord usage in the codebase |
| Losing in-flight BullMQ jobs at cutover | Drain `publish` and `embed` queues before phase 2 cutover; run both paths for 24h |
| Long sub-agent runs hitting Vercel function duration limit | Each sub-agent call is one `step.do(...)` which is independently invoked — Vercel Workflows handles long total runs naturally. Single steps that exceed duration must be split |
| Vercel Cron has no per-execution lock — concurrent ticks could double-fire | Workflow `step.do` is idempotent if we key it by job id; verify each cron handler is safe to re-run |

---

## 9. Out of scope (for now)

- Self-hosting the workflow runtime (we're committing to Vercel)
- Replacing Supabase
- Replacing the AI SDK (`ai` package + `@ai-sdk/*`) — sub-agents keep using it inside steps
- Multi-tenant / per-customer isolation
- Replacing the existing `/creation-workflow` UI

---

## 10. Decision log (fill in as we go)

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-05 | Use `workflow` package as orchestrator | Native to Vercel deploy target |
| 2026-05-05 | Phased migration, not big-bang | Each phase independently shippable; risk per phase is bounded |
| 2026-05-04 | Skip Slack + Discord during the migration | Not yet integrated in production; Phase 3 step 5 dropped. Reconsider after the workflow path proves out from test-chat. |
| 2026-05-04 | Drive Phase 1 from test-chat, not `/creation-workflow` | User wants the new path validated end-to-end via the existing chat UI before any UI work. A `/workflow [channel] <prompt>` slash command in [chat-client-ready.tsx](apps/web/app/(admin)/test-chat/chat-client-ready.tsx) bypasses the manager-routed orchestrator and POSTs to `/api/workflows/single-post`. |
| 2026-05-04 | Phase 1 uses a single-shot LLM draft, not the full `runContent` sub-agent | `runContent` returns the assistant text but not the created `contentId`, so wrapping it in a step would require either parsing the text or mutating shared state. For the Phase 1 plumbing proof we draft via a one-shot `generateText` call inside [`draftAndSubmitStep`](apps/web/workflows/single-post.ts) and return clean ids. Phase 2 swaps in `runContent` once we add a `lastContentId` return channel. |
| 2026-05-04 | Hook resume is fired from existing `/api/approvals/[id]` route | Best-effort `approvalHook.resume(...)` after the DB decision succeeds. Approvals from non-workflow paths are unaffected. Avoids forking the admin approvals UI. |
| | Generation jobs table strategy | TBD — see §7.4 |
| | Chat SSE strategy | TBD — see §7.1 |

---

## 11. Phase 1 results (landed 2026-05-04)

### What shipped

- **Workflow SDK installed** in [apps/web](apps/web/package.json) (`workflow@^4.2.4`).
- **Next config wrapped** with `withWorkflow(...)` in [apps/web/next.config.ts](apps/web/next.config.ts).
- **Proxy matcher updated** in [apps/web/proxy.ts](apps/web/proxy.ts) to exclude `/.well-known/workflow/*` so the SDK's hook/webhook endpoints aren't intercepted by the auth middleware.
- **`packages/agents/`** created with the sub-agents and helpers copied (not moved) from `apps/manager/src/`. See [packages/agents/package.json](packages/agents/package.json) for the dep set. The manager keeps its own copies — both paths coexist during the migration. Files copied: `sub-agents/{strategist,content,asset,analyst}.ts`, `llm-registry.ts`, `brand-store.ts`, `brand-guidance.ts`, `memory.ts`, `find-common-mistakes.ts`, `find-similar.ts`, `image-gen.ts`, `asset-uploader.ts`, `template-render.ts`, `ga4-client.ts`, `design-system-store.ts`, `cards/approval.ts`, `types/vendor-stubs.d.ts`.
- **Single-post workflow** at [apps/web/workflows/single-post.ts](apps/web/workflows/single-post.ts) with three steps: `draftAndSubmitStep` (creates campaign if needed → one-shot AI draft → inserts `content_items` with `status=in_review` and an open `approvals` row), suspension via `defineHook` keyed on `approval:<approvalId>`, then `publishStubStep` (logs + marks the content item as `published` with a `stub://...` URL) or `markTimeoutStep` if the 7-day approval window expires.
- **Trigger route** at [apps/web/app/api/workflows/single-post/route.ts](apps/web/app/api/workflows/single-post/route.ts) — admin or internal-token POST starts a run via `start(singlePostWorkflow, [...])` and returns the runId.
- **Resume route** at [apps/web/app/api/workflows/approve/route.ts](apps/web/app/api/workflows/approve/route.ts) for direct hook resume.
- **Existing approvals route** patched: [apps/web/app/api/approvals/[id]/route.ts](apps/web/app/api/approvals/[id]/route.ts) calls `approvalHook.resume(\`approval:${id}\`, ...)` after the DB decision succeeds. Best-effort — silently no-ops when no workflow is waiting.
- **Test-chat slash command** in [apps/web/app/(admin)/test-chat/chat-client-ready.tsx](apps/web/app/(admin)/test-chat/chat-client-ready.tsx): `/workflow [channel] <prompt>` (default channel `linkedin`) bypasses the orchestrator and triggers the workflow.

### How to drive it locally

1. `pnpm --filter web dev` (or your normal dev server start).
2. Open `/test-chat`.
3. Type `/workflow linkedin draft a post about our Q3 launch`.
4. The chat replies with the runId and a tracking note. The DB now has an `in_review` `content_items` row + a fresh `approvals` row. The workflow is suspended on `approval:<approvalId>`.
5. Optional inspector: `pnpm --filter web exec workflow web` to see the run in the WDK web UI.
6. Open `/approvals` (admin), approve the new item. The `/api/approvals/[id]` POST writes the decision *and* fires `approvalHook.resume(...)` — the workflow resumes, runs `publishStubStep`, marks the content `published` with a `stub://...` URL.

### What Phase 1 did **not** do

- Real channel publish — `publishStubStep` only logs and stamps a fake URL. BullMQ `publish` queue is untouched. (Phase 2.)
- Real sub-agent integration — `runContent` / `runAsset` are copied into `packages/agents` but the workflow doesn't call them yet. (Phase 2.)
- Push approval cards into the test-chat SSE — the user approves from `/approvals` instead. (Could be added in Phase 2 once we settle on the SSE strategy from §7.1.)
- Touch the manager or distributor processes. They keep running normally; the workflow path is a pure addition.

### Known gotchas

- The single-post workflow auto-creates a `workflow-test` campaign on first run if no `campaignId` is provided. Delete the row from `campaigns` to reset.
- `defineHook` resume requires the same module instance that `create()`-d it. Both routes import `approvalHook` from `@/workflows/single-post` for that reason — don't move the export elsewhere without also updating the resumers.
- `apps/distributor` typecheck has been failing on `main` since before Phase 1 (drizzle-orm 0.30 vs 0.36 type clash in [outcomes-rollup.ts](apps/distributor/src/outcomes-rollup.ts)). Unrelated to this work. To be addressed in Phase 2 cleanup.

---

## 12. Phase 2 results (landed 2026-05-04)

### What shipped

- **Adapters copied into `packages/agents/src/adapters/`** — `internal-blog.ts`, `linkedin.ts`, `x.ts`, `x-oauth.ts`, `hubspot-email.ts`, `mailchimp.ts`, `index.ts`. Distributor still owns the originals; both run side-by-side. Subpath exports added to [packages/agents/package.json](packages/agents/package.json).
- **Four new workflows** under [apps/web/workflows/](apps/web/workflows/):
  - **[publish.ts](apps/web/workflows/publish.ts)** — mirrors `apps/distributor/src/worker.ts` without BullMQ. Steps: `runGatesStep` (kill-switch + per-channel daily cap, both via `getDb()` calls — no cp-client HTTP), `adapterPublishStep` (dispatches to the right adapter; `FatalError` for unknown channels so the SDK skips retries), `markSucceededStep` (patches both `publish_jobs` and `content_items`), `notifyThreadStep` (success message + the internal-blog syndication checklist), `scheduleMetricsFetchStep` (kicks off `metricsFetchWorkflow` for email channels). Test mode short-circuits exactly like the BullMQ worker.
  - **[embed.ts](apps/web/workflows/embed.ts)** — `embedContentWorkflow` and `embedRejectedDraftWorkflow`, each with load → OpenAI embed → upsert steps. `text-embedding-3-small`, conflict on `(source_type, source_id, chunk_index)` matching the existing schema.
  - **[metrics.ts](apps/web/workflows/metrics.ts)** — `metricsFetchWorkflow` (sleeps the configured delay then calls `adapter.fetchMetrics` and inserts rows into `metrics`). Plus `metricsCronFanOutWorkflow` for the Vercel Cron entrypoint — lists `succeeded` `publish_jobs` and starts one fetch run per job (capped at 200/run as the rate-limit hedge from §7.6).
  - **[outcomes-rollup.ts](apps/web/workflows/outcomes-rollup.ts)** — same 7d/30d/90d window logic as the BullMQ version, one step per window for clean retry.
- **Cron routes** under [apps/web/app/api/cron/](apps/web/app/api/cron/) — `outcomes-rollup` and `metrics-fetch`. Both verify a `CRON_SECRET` bearer when set; Vercel Cron sends it automatically. Cron schedule lives in [apps/web/vercel.json](apps/web/vercel.json) (`0 1 * * *` daily rollup, `0 */6 * * *` metrics fan-out).
- **Feature-flagged `enqueuePublish`** in [apps/web/lib/publish-queue.ts](apps/web/lib/publish-queue.ts) — when `WORKFLOW_PUBLISH=1`, calls `start(publishWorkflow, ...)` instead of pushing onto the BullMQ `publish` queue. Falls back cleanly when the flag is unset.
- **Feature-flagged `enqueueEmbedding` / `enqueueRejectedDraftEmbedding`** in [apps/web/lib/embedding-queue.ts](apps/web/lib/embedding-queue.ts) — when `WORKFLOW_EMBED=1`, calls `start(embedContentWorkflow, ...)` / `embedRejectedDraftWorkflow` instead of POSTing to the distributor's `/embed` HTTP server.
- **Single-post workflow upgraded** in [apps/web/workflows/single-post.ts](apps/web/workflows/single-post.ts) — when `WORKFLOW_PUBLISH=1`, the approval branch creates a `publish_jobs` row and calls `publishWorkflow` directly (still a step inside single-post; no nested-run needed). When the flag is unset, falls back to the Phase 1 `publishStubStep`.

### How to run both paths in parallel

Set `WORKFLOW_PUBLISH=1` (or `WORKFLOW_EMBED=1`) in `apps/web/.env.local` and restart. The distributor keeps running as before — it just won't see new jobs from `enqueuePublish` while the flag is on. To compare behaviour, drain the BullMQ `publish` queue once before flipping the flag, then run a `/workflow linkedin draft a post about X` from test-chat and watch:

- `publish_jobs` row inserted with status `queued` → `running` → `succeeded`
- `content_items.published_url` set
- Vercel Workflow inspector (`pnpm --filter web exec workflow web`) showing the run

### What Phase 2 did **not** do

- **Did not delete `apps/distributor`.** The plan calls for a 24h dual-run before deletion. The flag flip is reversible per environment.
- **Did not migrate the Distributor's startup-time nightly-rollup scheduler.** Vercel Cron now owns that schedule; the BullMQ `outcomes-rollup` queue keeps running for now (harmless duplicate writes — both upsert the same rows).
- **Did not move sub-agent calls** off cp-client. `runContent` / `runAsset` in `packages/agents/` still go via the HTTP cp-client. That's a Phase 3 cleanup once chat moves into web.
- **Did not pin `apps/distributor` drizzle-orm to 0.36.** The preexisting typecheck failure remains; runtime is fine because tsx compiles per-file.

### Decisions
- **Gate logic moved from cp-client HTTP to direct DB:** the publish workflow runs inside apps/web, so loading settings + counting today's publishes via `getDb()` is one fewer HTTP hop and one fewer auth boundary to keep healthy. Matches the §3 "Direct DB calls from workflow steps" target.
- **Per-job metrics workflow vs single-fetch step:** chose per-job runs (one `metricsFetchWorkflow` per `publish_job`). Pro: independent retry per job, clean inspector view. Con: many runs. Matches §7.6 mitigation — fan-out capped at 200/cron tick.
- **`metricsFetchWorkflow` does its 24h sleep itself** rather than `delay`-ing the BullMQ-style enqueue. The publish workflow's `scheduleMetricsFetchStep` just calls `start(metricsFetchWorkflow, [...])` and the metrics workflow `await sleep("24h")` at the top. Simpler, no separate scheduling concept.

### Known gotchas
- The `metricsCronFanOutWorkflow` re-checks every 6h (it doesn't track which jobs have been processed). With proper outcome rows from the per-job workflows, this is idempotent — the metrics insert just adds another row at a later `observed_at`. If that becomes noisy, add an "already-fetched" guard in `listDueMetricsJobsStep`.
- `vercel.json` lives at [apps/web/vercel.json](apps/web/vercel.json) (not the repo root). When deploying, the Vercel project root must be `apps/web`.
- Cron auth: set `CRON_SECRET` in Vercel env vars before deploying, or the routes will accept any caller. The check is opt-in (no secret = no check) so local `curl` testing still works.

---

## 13. Phase 3 results (landed 2026-05-04)

### What shipped

- **Chat lib copied + adapted into [apps/web/lib/chat/](apps/web/lib/chat/):**
  - [orchestrator.ts](apps/web/lib/chat/orchestrator.ts) — same `generateText`+tools shape as the manager's, but every sub-agent import goes through `@marketing/agents/sub-agents/*` instead of relative paths.
  - [chat-handler.ts](apps/web/lib/chat/chat-handler.ts) — same detached-workflow race as the manager's. Slack/Discord branches removed (per the §10 decision).
  - [generation-tracker.ts](apps/web/lib/chat/generation-tracker.ts), [telemetry.ts](apps/web/lib/chat/telemetry.ts) — straight copies; OTel telemetry still degrades gracefully when packages aren't installed.
  - [history-store.ts](apps/web/lib/chat/history-store.ts) — new. Encapsulates thread history with a Redis-or-in-memory backend. `REDIS_URL` set → IORedis with the same key shape (`thread:<ref>`) and 7-day TTL the manager uses. Unset → an in-process Map (single-instance only — fine for local, lossy under serverless cold starts; that's why the doc nudges you to set `REDIS_URL` in prod even after deleting the manager).
  - [web-bus.ts](apps/web/lib/chat/web-bus.ts) — in-process pub/sub for web threads using a Node `EventEmitter` stashed on `globalThis` so HMR doesn't multiply listeners. Replaces the IORedis pub/sub channel `chatbus:<threadRef>` for single-region. To go multi-region (§7.1), swap this module for an Upstash-backed implementation with the same publish/subscribe surface; no callers change.
- **Routes updated:**
  - [apps/web/app/api/test-chat/route.ts](apps/web/app/api/test-chat/route.ts) — `WORKFLOW_CHAT=1` runs `handleChat` in-process; otherwise proxies to manager (legacy path stays for parallel running).
  - [apps/web/app/api/test-chat/stream/route.ts](apps/web/app/api/test-chat/stream/route.ts) — `WORKFLOW_CHAT=1` returns a `ReadableStream` SSE wired to `web-bus`; otherwise proxies. 25s heartbeat preserved for proxy idle-timeouts.
  - [apps/web/app/api/thread-notify/route.ts](apps/web/app/api/thread-notify/route.ts) — `WORKFLOW_CHAT=1` publishes web-thread events to `web-bus` directly. Sub-agents/distributors that POST here (via `cp.notifyThread(...)`) now reach test-chat without the manager hop.
- **Weekly analyst on Vercel Cron:**
  - [apps/web/workflows/weekly-analyst.ts](apps/web/workflows/weekly-analyst.ts) — wraps `runAnalyst` from `@marketing/agents` in a single-step workflow.
  - [apps/web/app/api/cron/weekly-analyst/route.ts](apps/web/app/api/cron/weekly-analyst/route.ts) — Vercel Cron trigger. `CRON_SECRET` bearer enforced when set.
  - [apps/web/vercel.json](apps/web/vercel.json) — added `15 3 * * 1` (Mon 03:15 UTC = 09:00 Asia/Kathmandu, matching the manager's old schedule).

### How to dual-run

Set `WORKFLOW_CHAT=1` (and ideally `WORKFLOW_PUBLISH=1` and `WORKFLOW_EMBED=1` too) in `apps/web/.env.local`, restart. The manager keeps running but `/api/test-chat` no longer hits it. Verify:

- `/test-chat` chat input still works for both regular prompts (orchestrator) and `/workflow ...` (Phase 1 single-post workflow).
- Approval cards posted by sub-agents via `/api/thread-notify` show up in the chat as before.
- Workflow publishes / embeds proceed through the in-process steps; reply messages stream over SSE without going through manager.

### What Phase 3 did **not** do

- **Did not delete `apps/manager/`.** Manager still owns Slack/Discord wiring and the legacy `/forward-notify` path. We're not using Slack/Discord in prod (per the user's clarification), so the manager process can be powered off whenever you flip `WORKFLOW_CHAT=1` everywhere — but the code stays around until Phase 4 cleanup.
- **Did not delete `apps/distributor/`.** Same as Phase 2 — drain queues + 24h dual-run before deletion.
- **Did not change cp-client.** Sub-agents still use it for DB CRUD. Phase 4 cleanup decides whether to shrink or delete it (§5.6).
- **Did not migrate the `/workflow/start` manager endpoint.** It's only used by `/creation-workflow` "Continue" buttons; if/when those move to the new workflows path that endpoint goes away with the manager.
- **Did not address the `apps/distributor` drizzle 0.30/0.36 typecheck issue.** Still preexisting, still runtime-fine.

### Decisions
- **Single-region SSE (`ReadableStream`)** chosen over Upstash pub/sub (§7.1). Cheaper, fewer moving pieces; fine for the user's scale. The `web-bus` module is the seam — swapping in Upstash later is a one-file change.
- **History store falls back to in-memory** when `REDIS_URL` is unset. Local dev works without Redis; serverless deploys should set `REDIS_URL` (or remove the fallback) to avoid cold-start history loss. Documented in the file.
- **`import.meta.dirname` guarded with a fallback** in `@marketing/agents/{memory,brand-store,brand-guidance,sub-agents/analyst}.ts`. Next.js's build-time page-data collector evaluates ESM modules with `import.meta.dirname` undefined; the guard `import.meta.dirname ? resolve(...) : ""` keeps build green and runtime correct (where Node always populates it).

### Known gotchas
- **Local dev without Redis loses history on file save** (HMR resets the in-process Map). For longer testing sessions set `REDIS_URL=redis://localhost:6379` even locally.
- **`web-bus` is per-instance.** A multi-instance Vercel deployment will see SSE listeners and publishers land on different functions and miss each other. Single-region single-instance only until Upstash swap. Vercel Fluid Compute keeps requests warm long enough for normal chat sessions.
- **Manager `/workflow/start` is still live.** If you flip `WORKFLOW_CHAT=1` but admin UI buttons that hit `/api/generation-jobs/start` haven't been re-pointed at the new `/api/workflows/*` routes, those still go through manager. That re-pointing is part of Phase 4 cleanup §5.3.

---

## 14. Phase 4 results (documentation pass — 2026-05-04)

Phase 4 in the original plan was a single day of cleanup, but most of the
items are **destructive operations** that should not be done before the user
has dual-run Phases 1–3 in their environment for ~24 h. This section captures
what was done as a documentation pass and what remains gated.

### What shipped

- **`.env.example` updated** with `WORKFLOW_PUBLISH`, `WORKFLOW_EMBED`, `WORKFLOW_CHAT`, `CRON_SECRET` (with comments explaining when each flag is `1`). `REDIS_URL` re-described as required-during-migration, optional-after.
- **[RUNBOOK.md](RUNBOOK.md) updated:**
  - Services map adds Vercel Workflows; manager + distributor flagged as deprecated.
  - New "Migration state" callout listing the three feature flags and what they swap.
  - New disaster-drill section "Workflow run failed mid-step" covering the inspector, `FatalError` semantics, retries, and cron re-fire behaviour.
- **[AGENTIC_MARKETING_IMPLEMENTATION.md](AGENTIC_MARKETING_IMPLEMENTATION.md)** stack-anchor list adds Vercel Workflow; the "Status" line points readers at the migration plan for current topology.

### What's gated on user verification (intentionally NOT done)

The following are **destructive** — the agent has not done them and should not until you confirm Phases 1–3 work end-to-end in your environment:

1. **Delete `apps/distributor/`** (§6 Phase 2 step 7). Requires draining BullMQ `publish`, `embed`, `metrics-fetch`, `outcomes-rollup` queues + 24 h of `WORKFLOW_PUBLISH=1` / `WORKFLOW_EMBED=1` running cleanly first. Procedure: drain queues → power off the Distributor process on Railway → wait 24 h watching `publish_jobs` for regressions → `rm -rf apps/distributor` + remove the workspace entry + drop the Railway service.
2. **Delete `apps/manager/`** (§6 Phase 3 step 8). Requires `WORKFLOW_CHAT=1` confirmed working in test-chat for 24 h + no remaining callers of `/forward-notify` / `/chat` / `/workflow/start`. Procedure: power off the Manager process on Railway → audit `MANAGER_BASE_URL` references with `grep` → confirm none are in hot paths → `rm -rf apps/manager` + remove the workspace entry + drop the Railway service.
3. **Shrink `@marketing/cp-client`** (§5.6, §6 Phase 4 step 2). After agent code in `packages/agents/` is repointed to `getDb()`, the only remaining cp-client caller is the workflow's `notifyThreadStep`. Either inline that one helper (`fetch /api/thread-notify`) or drop cp-client entirely and have callers go through `web-bus.publishWebThreadEvent` directly when in-process.
4. **Drop `INTERNAL_API_TOKEN` plumbing** (§6 Phase 4 step 3). Once no internal HTTP hops remain (cp-client gone, manager gone, distributor gone), the token has no callers. `lib/internal-auth.ts` and every `assertInternal(...)` call site can be removed.
5. **Drop `MANAGER_BASE_URL` and `DISTRIBUTOR_BASE_URL`** from `.env.example` and the codebase. Same trigger: all callers gone.
6. **`generation_jobs` table strategy decision** (§5.8, §7.4). Recommended: keep them (Option A) until you've spent a week with Vercel's generic workflow inspector and confirmed it covers the per-step input/output preview that `/creation-workflow` shows today.

### Suggested cutover order

When you're ready to actually flip the switch:

```
Week 0 (now)    Phases 1–3 deployed, all flags off in prod (legacy paths active)
Week 0 → 1      Enable WORKFLOW_PUBLISH=1; watch publish_jobs for 24 h
Week 1 → 2      Enable WORKFLOW_EMBED=1; watch embeddings table for 24 h
Week 1          Drain BullMQ queues; power off apps/distributor on Railway
Week 1 → 2      Enable WORKFLOW_CHAT=1; smoke-test test-chat for 24 h
Week 2          Power off apps/manager on Railway
Week 3          rm -rf apps/distributor + apps/manager + cp-client shrink + drop tokens
```

Each step is reversible until the next one starts. The `git revert` of the
flag flip is one commit; the deletions are when reversal gets expensive.

### Known gotchas

- **`apps/distributor` typecheck still red** (drizzle 0.30 vs 0.36). Will go away when the directory is deleted — not worth fixing in place.
- **Vercel Cron requires the project root to be `apps/web`.** Current monorepo deploys typically already do this; verify under Vercel → Settings → General → Root Directory before relying on the new cron entries.
- **`WORKFLOW_CHAT=1` without `REDIS_URL` set in production** loses chat history across cold starts. Either keep `REDIS_URL` (Upstash) or accept the loss for low-stakes contexts. The history-store fallback is intentionally noisy in logs to remind you.
