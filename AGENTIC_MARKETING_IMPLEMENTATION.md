# Agentic Marketing Platform — Final Implementation Plan

**Stack anchors:** Next.js 15 · Zustand · TanStack Query · Supabase · Drizzle
**Calibrated to:** TypeScript/Node, React/Next.js, Postgres, Redis, Docker, Drizzle, LLM SDKs, Slack/Discord APIs, OAuth
**Last updated:** 2026-04-30
**Status:** Final

---

## 1. The Final Stack

Five anchors. Everything else is inferred.

### The five anchors

- **Next.js 15** — admin UI _and_ Control Plane API in one app, App Router with Server Components for read-heavy pages and Route Handlers for the API surface.
- **Zustand** — client-side UI state. Editor buffers, queue filters, optimistic flags. Tiny, no Provider tree, devtools support.
- **TanStack Query** — server state on the client. Every Postgres-backed read goes through it. Caching, refetch, optimistic mutations, SSR hydration.
- **Supabase** — Postgres, Auth, Storage, Realtime. Single managed dependency that replaces Neon + Clerk + Cloudflare R2 + a manual realtime layer.
- **Drizzle ORM** — SQL-first type-safe queries over Supabase's Postgres. Migrations via `drizzle-kit`.

### Inferred from those anchors

| Layer                  | Choice                                           | Why this follows from the anchors                         |
| ---------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Language               | TypeScript 5 strict                              | Required by Drizzle and Next.js                           |
| Runtime                | Node.js 20 LTS                                   | Next.js + OpenClaw both require Node                      |
| Monorepo               | pnpm workspaces                                  | Standard for Next.js + multi-service repos                |
| Agent runtime          | OpenClaw (Manager + Distributor)                 | Required by the architecture                              |
| Reasoning              | Vercel AI SDK + Anthropic Claude                 | Provider-agnostic, streams to Chat SDK                    |
| Messaging              | Vercel Chat SDK + Slack + Discord adapters       | One handler, both platforms                               |
| Queue                  | BullMQ on Upstash Redis                          | Supabase doesn't ship a queue; this is the standard pair  |
| Chat SDK state         | `@chat-adapter/state-redis` (same Upstash Redis) | One Redis, two consumers                                  |
| UI primitives          | Tailwind CSS + shadcn/ui                         | Standard with Next.js                                     |
| Tables                 | TanStack Table                                   | Pairs naturally with TanStack Query                       |
| Forms                  | React Hook Form + Zod                            | Validation shared with Drizzle schemas via Zod            |
| Auth                   | Supabase Auth                                    | One of the anchors                                        |
| Storage (assets)       | Supabase Storage                                 | One of the anchors                                        |
| Realtime               | Supabase Realtime                                | Free with Supabase                                        |
| Templating (Phase 6.5) | Bannerbear or Placid                             | Don't build a renderer                                    |
| Image generation       | Replicate (FLUX/SDXL/Ideogram)                   | Don't manage GPUs                                         |
| Secrets                | Doppler (prod) + `.env.local` (dev)              | Adapter credentials, runtime fetch                        |
| Observability          | OpenTelemetry + Grafana Cloud                    | Free tier, traces from Slack to adapter                   |
| Logging                | Pino                                             | Standard structured logging                               |
| Testing                | Vitest + Testcontainers + MSW + Playwright       | Unit, integration, mocked external, E2E                   |
| Deployment             | Vercel (Next.js) + Railway (OpenClaw processes)  | Vercel for the Next app, Railway for long-running workers |
| CI                     | GitHub Actions                                   | Standard                                                  |

### What dropped from the previous plan and why

- **Fastify** — replaced by Next.js Route Handlers. One deploy surface beats two.
- **Neon** — Supabase Postgres is functionally equivalent for this scale and bundles the rest.
- **Clerk** — Supabase Auth covers the same surface; one fewer vendor.
- **Cloudflare R2** — Supabase Storage covers the same surface; one fewer vendor.
- **TypeBox** — Zod is the better pair with Drizzle (`drizzle-zod` generates Zod schemas from Drizzle tables) and with React Hook Form.

### The one place to think hard

**Where does the API live — Next.js Route Handlers or a separate Node service?** With Supabase + Next.js, Route Handlers are the right answer for this scale. They share the Drizzle client, the Supabase client, the auth middleware, and the typed schemas with the admin UI. The OpenClaw Manager and Distributor still call this same Next.js API over HTTP — they're just clients of the same surface that the UI uses.

The boundary is clean: the Next.js app is the **Control Plane**. The two OpenClaw processes are **clients of the Control Plane**. Same as before, just with a different framework choice for the Control Plane.

---

## 2. Repository Structure

A pnpm workspace with three deployable apps and four shared packages.

```
marketing-platform/
├── pnpm-workspace.yaml
├── package.json
├── docker-compose.yml                 # local dev: openclaw processes only
├── .github/workflows/ci.yml
├── .doppler.yaml
├── drizzle.config.ts
│
├── packages/
│   ├── shared-types/                  # PublishJob, ContentItem, Channel
│   │   └── src/index.ts
│   ├── db/                            # Drizzle schema + client
│   │   ├── src/schema.ts
│   │   ├── src/client.ts
│   │   └── drizzle/                   # generated migrations
│   ├── cp-client/                     # typed HTTP client OpenClaw uses
│   │   └── src/index.ts
│   └── prompts/                       # sub-agent system prompts
│       └── src/{strategist,content,analyst,asset,orchestrator}.ts
│
├── apps/
│   ├── web/                           # Next.js 15: admin UI + API + public blog
│   │   ├── app/
│   │   │   ├── (admin)/
│   │   │   │   ├── approvals/page.tsx
│   │   │   │   ├── campaigns/page.tsx
│   │   │   │   ├── campaigns/[id]/page.tsx
│   │   │   │   ├── audit-log/page.tsx
│   │   │   │   └── settings/page.tsx
│   │   │   ├── api/
│   │   │   │   ├── campaigns/route.ts
│   │   │   │   ├── content/route.ts
│   │   │   │   ├── approvals/[id]/route.ts
│   │   │   │   ├── publish-jobs/route.ts
│   │   │   │   ├── assets/route.ts
│   │   │   │   ├── metrics/route.ts
│   │   │   │   ├── thread-notify/route.ts
│   │   │   │   └── webhook/[provider]/route.ts
│   │   │   ├── blog/[slug]/page.tsx   # public blog rendering
│   │   │   └── layout.tsx
│   │   ├── components/
│   │   │   ├── approval-card.tsx
│   │   │   ├── campaign-table.tsx
│   │   │   └── audit-table.tsx
│   │   ├── lib/
│   │   │   ├── store/                 # Zustand stores
│   │   │   │   ├── approval-queue.ts
│   │   │   │   └── editor.ts
│   │   │   ├── query/                 # TanStack Query hooks
│   │   │   │   ├── use-content.ts
│   │   │   │   ├── use-campaigns.ts
│   │   │   │   └── use-approvals.ts
│   │   │   ├── supabase/              # supabase clients
│   │   │   │   ├── server.ts
│   │   │   │   └── client.ts
│   │   │   ├── auth.ts
│   │   │   ├── audit.ts
│   │   │   └── state-machine.ts
│   │   └── package.json
│   │
│   ├── manager/                       # OpenClaw #1 (Manager)
│   │   ├── src/
│   │   │   ├── index.ts               # Chat SDK bot entry
│   │   │   ├── orchestrator.ts        # top-level ToolLoopAgent
│   │   │   ├── sub-agents/
│   │   │   │   ├── strategist.ts
│   │   │   │   ├── content.ts
│   │   │   │   ├── analyst.ts
│   │   │   │   └── asset.ts
│   │   │   ├── tools/
│   │   │   ├── cards/approval.tsx     # JSX card
│   │   │   └── thread-poster.ts
│   │   ├── memory/                    # git-tracked Markdown
│   │   │   ├── brand/
│   │   │   ├── product/
│   │   │   ├── campaigns/
│   │   │   ├── learnings/
│   │   │   └── playbooks/
│   │   └── package.json
│   │
│   └── distributor/                   # OpenClaw #2 (Distributor)
│       ├── src/
│       │   ├── index.ts               # BullMQ worker entry
│       │   ├── worker.ts
│       │   └── adapters/
│       │       ├── internal-blog.ts
│       │       ├── linkedin.ts
│       │       ├── x.ts
│       │       ├── hubspot-email.ts
│       │       ├── mailchimp.ts
│       │       └── ga4.ts
│       ├── memory/channel-sops/
│       └── package.json
│
└── infra/
    ├── railway.toml
    └── supabase/
        ├── seed.sql
        └── policies.sql               # RLS policies
```

Three things worth calling out:

- **`packages/db`** is the single Drizzle schema, imported by both `apps/web` (the API and UI) and `apps/manager`/`apps/distributor` (which read it indirectly through `cp-client`). The schema is the contract; everything else is plumbing.
- **`apps/web`** is the only Vercel deployment. The `manager` and `distributor` apps run on Railway as long-running Node processes (BullMQ workers and the Chat SDK bot can't run on Vercel's serverless model).
- **Memory directories are committed** to the repo (with secrets-pattern `.gitignore`), giving you the audit trail and history that "remember everything" promises.

---

## 3. Data Layer with Drizzle + Supabase

The schema is the most load-bearing artifact in the entire system. Every later phase depends on it.

### Core tables

```
campaigns
  id (uuid, pk), slug, name, status,
  phase (enum: buildup | launch | post_launch),
  owner_id (fk auth.users), start_date, end_date,
  brief_md, calendar_json,
  created_at, updated_at

content_items
  id (uuid, pk), campaign_id (fk),
  type (enum: blog | linkedin | x_thread | x_post | email),
  stage (enum: pull | explain | reinforce | push),
  title, body_md, channel_hints (jsonb),
  status (enum: draft | in_review | approved | scheduled | published | retracted),
  scheduled_for, published_at, published_url,
  current_revision_id, created_at, updated_at

content_revisions
  id (uuid, pk), content_id (fk),
  body_md, change_note, author_id, author_kind (human | agent),
  created_at

approvals
  id (uuid, pk), content_id (fk),
  requested_at, decided_at, decision (approved | changes_requested | rejected),
  decided_by (fk auth.users), reason

publish_jobs
  id (uuid, pk), content_id (fk), channel,
  scheduled_at, status (queued | running | succeeded | failed | cancelled),
  attempts, external_id, external_url, error,
  thread_ref, requested_by,
  created_at, updated_at

assets
  id (uuid, pk), content_id (fk),
  kind (poster | hero | og | email_header),
  status (draft | in_review | approved | published),
  storage_path (Supabase Storage path),
  template_id, prompt_used,
  created_at, updated_at

metrics
  id (uuid, pk),
  scope_type (content | campaign), scope_id,
  channel, metric, value (numeric), observed_at

audit_log
  id (uuid, pk), actor_id, actor_kind (human | agent | system),
  action, entity_type, entity_id,
  before (jsonb), after (jsonb), at

settings
  key (pk), value (jsonb), updated_by, updated_at
  # kill_switch, channel_caps, approval_policy
```

### Drizzle conventions

- Every enum is a Drizzle `pgEnum`, exported and reused in `shared-types`.
- Every table has `created_at` / `updated_at` with `defaultNow()`.
- Foreign keys are declared with `references()` so Drizzle generates the cascade behavior.
- Use `drizzle-zod` to derive Zod schemas from each table — these become your API request/response validators.

### Row Level Security (RLS) — turn it on

Supabase exposes Postgres directly to authenticated clients. RLS is non-negotiable. Two policy classes:

- **Admin-only tables** (`audit_log`, `settings`, `publish_jobs`): only authenticated team members can read; nobody can insert from the client (server-side only).
- **Editable tables** (`campaigns`, `content_items`, `content_revisions`, `approvals`, `assets`): authenticated team members can read and write subject to state-machine rules; the agent service role bypasses RLS for its writes.

### The critical guardrail

The Control Plane refuses to insert a `publish_jobs` row whose `content_id` does not have `status = 'approved'`. This check lives in the Route Handler, _and_ a `BEFORE INSERT` Postgres trigger enforces it at the database level too. **Belt and suspenders, because this is the one rule the entire safety story rests on.**

---

## 4. State Architecture: Zustand + TanStack Query

The split is the entire point. Get this right and the admin UI is a joy. Get it wrong and you'll spend weeks debugging stale data.

### TanStack Query handles all server state

Every read of Postgres data on the client is a `useQuery`. Examples:

- `useCampaigns()` — list of campaigns
- `useCampaign(id)` — single campaign with content items
- `useApprovalQueue()` — pending approvals across all campaigns
- `useAuditLog(filters)` — paginated audit entries

Every write is a `useMutation` with optimistic update + invalidation:

- `useApproveContent()` — POSTs to `/api/approvals/:id`, optimistically flips status, invalidates campaign and approval queue queries.
- `useCreateContent()` — POSTs to `/api/content`, invalidates the campaign query.
- `useToggleKillSwitch()` — POSTs to `/api/settings/kill-switch`, invalidates settings.

### Zustand handles only client state

Things that don't live in Postgres:

- **`useEditorStore`** — the unsaved draft buffer when a human is editing content in the admin UI. Persists to `localStorage` so a refresh doesn't lose work. Does not touch the server until "Save" is clicked.
- **`useApprovalQueueStore`** — current filter, sort, selection state. Pure UI.
- **`useNotificationStore`** — toasts and inline status messages.
- **`useFeatureFlagsStore`** — local overrides for development.

### Why this split matters

The temptation is to store campaigns in Zustand because "it's faster." Don't. TanStack Query gives you cache invalidation, automatic refetch on focus, optimistic updates, and SSR hydration for free. Zustand gives you none of that for server data — you'd reimplement it badly.

**The rule: if it's in Postgres, it goes in TanStack Query. Otherwise, Zustand.**

### SSR hydration

Next.js Server Components query Postgres directly via Drizzle (no API roundtrip), then pass the data to client components which seed TanStack Query's cache via `dehydrate` / `Hydrate`. The result: pages feel instant on first load and stay live thereafter. Standard pattern, well-documented.

### Realtime subscriptions

Supabase Realtime emits Postgres change events over WebSocket. Subscribe in the admin UI to `content_items`, `approvals`, `publish_jobs` — when an event arrives, invalidate the matching TanStack Query keys. Result: when someone in Slack approves a draft, the admin UI updates within a second without polling. Free, no extra service.

---

## 5. Phase-by-Phase Implementation Plan

Estimates assume **solo full-time** baseline. Multiply by 1.6× for solo part-time, 0.7× for two devs full-time.

### Phase 0 — Foundation (2 days)

**Day 1 — Repo, Supabase, Drizzle.**

- pnpm workspace scaffold with the structure above.
- Create Supabase project. Get connection string + anon/service keys into Doppler.
- Drizzle config pointing at Supabase Postgres.
- First migration: `audit_log` table only.
- Empty Next.js app at `apps/web` with one page that confirms DB connectivity.

**Day 2 — Auxiliary services and bot apps.**

- Provision Upstash Redis. Wire into a stub BullMQ producer in `apps/web` and a stub consumer in `apps/distributor`.
- Provision Doppler. Wire to all three apps.
- Provision Grafana Cloud. Wire OpenTelemetry into `apps/web` with a sample trace.
- **Start the LinkedIn Marketing API access request now** — approval is days to weeks; you'll need it in Phase 6.
- **Verify X API tier and pricing** — this is the moment to confirm Basic covers your volume.
- Register Slack and Discord bot apps. Don't wire handlers yet; just claim the workspaces.

**Exit criteria.** All services provisioned; `docker-compose up` brings the manager and distributor up; `apps/web` runs locally and connects to Supabase; a sample trace lands in Grafana; LinkedIn application submitted.

---

### Phase 1 — Control Plane Core (5–7 days)

This phase is the longest-pole investment. Don't compress.

**Day 1 — Schema and migrations.**

- Drizzle schema for all tables in §3. Enums first (status, phase, stage, decision, scope_type), tables second.
- Generate first migration with `drizzle-kit`. Apply to Supabase.
- Drizzle-Zod schemas exported from `packages/db`.

**Day 2 — RLS and the trigger.**

- Write the SQL policies in `infra/supabase/policies.sql`. Apply via Supabase SQL editor.
- Write the `BEFORE INSERT` trigger on `publish_jobs` enforcing the approval invariant.
- Test with the Supabase client: confirm an unauthenticated request fails, an authenticated one succeeds, and an attempt to insert a publish_job for unapproved content fails at the database level.

**Day 3 — State machine and audit.**

- `lib/state-machine.ts`: a `canTransition(from, to)` lookup table for content_items and assets. Pure function, fully tested.
- `lib/audit.ts`: a higher-order function that wraps any mutation, captures before/after, writes to `audit_log`. Use it on every mutating Route Handler.

**Day 4 — Route Handlers.**

- `POST /api/campaigns`, `GET /api/campaigns`, `GET /api/campaigns/:id`.
- `POST /api/content`, `PATCH /api/content/:id`, `POST /api/content/:id/submit`.
- `POST /api/approvals/:id` with state-machine validation.
- `GET /api/audit-log` with pagination.
- Every handler validates inputs with the Drizzle-Zod schemas; every mutation goes through the audit wrapper.

**Day 5 — Auth.**

- Supabase Auth wired into Next.js with the official `@supabase/ssr` package.
- Server-side session reads in Server Components.
- Middleware that redirects unauthenticated users to the Supabase Auth UI.
- Service-role key for OpenClaw processes — they call the API with `X-Internal-Token` header validated server-side.

**Day 6 — Admin UI: campaigns and content.**

- `(admin)/campaigns/page.tsx`: Server Component lists campaigns, hands data to a client `CampaignTable` using TanStack Table.
- `(admin)/campaigns/[id]/page.tsx`: Server Component fetches campaign + content items.
- TanStack Query hooks for the mutations (create/edit content) so the UI updates optimistically.

**Day 7 — Tests and integration.**

- Testcontainers spin up Postgres locally for tests.
- Integration tests covering: create campaign, full content lifecycle (draft → in_review → approved → rejected path → audit log assertions), approval rejected for invalid transitions.
- Vitest in CI.

**Exit criteria.** A human can create a campaign in the admin UI, draft a content item, submit for review, approve it. The `publish_jobs` table refuses inserts for unapproved content (verified by integration test). Every state change appears in the audit log.

---

### Phase 2 — Messaging Surface (3 days)

**Day 1 — Chat SDK skeleton.**

- Install `chat`, `@chat-adapter/slack`, `@chat-adapter/discord`, `@chat-adapter/state-redis` in `apps/manager`.
- Bot wired with `onNewMention` handler that echoes input.
- Redis state adapter pointing at Upstash.

**Day 2 — Bot registration and verification.**

- Slack: scopes (`app_mentions:read`, `chat:write`, `commands`, `users:read`), event-subscriptions URL pointing at Manager (use ngrok for local dev), OAuth install to your workspace.
- Discord: gateway intents, slash command registration.
- Verify `@marketing hello` works in both platforms.

**Day 3 — Thread refs and persistence.**

- Define the `thread_ref` format: `slack:C{channel_id}:T{ts}` and `discord:C{channel_id}:T{message_id}`.
- Build a `threadPoster.ts` module that, given a thread_ref, posts a message via Chat SDK to the right platform/channel/thread.
- Restart the Manager mid-conversation; verify thread state persists via Redis.

**Exit criteria.** `@marketing hello` works in both platforms; thread subscription survives a Manager restart; the thread-poster module can post to either platform given a thread_ref.

---

### Phase 3 — Strategist and Content Sub-Agents (5–7 days)

This is where prompt engineering dominates over coding.

**Day 1 — Orchestrator scaffold.**

- Vercel AI SDK in the Manager with `@ai-sdk/anthropic`.
- Top-level `ToolLoopAgent` (the Orchestrator) with five tools: `run_strategist`, `run_content`, `run_analyst`, `run_distributor`, `clarify`.
- Each tool is a stub that logs and returns a placeholder.
- Wire into `onNewMention` so user messages reach the orchestrator.

**Day 2 — Memory loader and CP client.**

- `loadMemory()` helpers reading `brand/voice.md`, `brand/icp.md`, `product/state.md`, `product/positioning.md`, plus campaign-specific memory.
- `cp-client` package: typed HTTP client that hits the Next.js API with the internal token.
- Tools wired to the cp-client.

**Day 3 — Strategist sub-agent.**

- System prompt encoding your seven-step methodology — product clarity, lock core ideas, stage thinking, sequence flow, simple structure, signal-driven iteration, product-timing alignment.
- Tools: `read_memory`, `create_campaign`, `update_campaign`, `write_calendar`, `read_past_learnings`.
- First test: ask it to plan a launch. Iterate the prompt until output matches your style.

**Day 4 — Content sub-agent.**

- System prompt with stage awareness, sequence position, brand voice enforcement.
- Tools: `read_brief`, `read_memory`, `create_content`, `revise_content`, `submit_for_review`.
- First test: drafting blog and X-thread variants. Iterate.

**Day 5–6 — Prompt iteration.**

- Run real campaigns. Review every output. Tighten prompts where drift happens. This is unglamorous but it's the heart of the phase.
- Add few-shot examples to prompts where the agent struggles to internalize a style rule.
- Document final prompts in `packages/prompts` so they're versioned alongside code.

**Day 7 — Tracing and tests.**

- OpenTelemetry spans around each sub-agent invocation and each tool call. Verify a full Slack-to-DB trace appears in Grafana.
- Smoke tests for happy-path strategist and content invocations.

**Exit criteria.** `@marketing plan a campaign for X` produces a brief that reads like your own writing. `@marketing draft the launch post` produces a draft that passes brand-voice review on first read most of the time.

---

### Phase 3.5 — Marketing Methodology Integration (2 days)

**Day 1 — Schema additions and product memory.**

- `phase` enum added to campaigns; `stage` enum added to content_items. Migration. Update Drizzle-Zod and shared types.
- Scaffold `memory/product/state.md` and `memory/product/positioning.md` with your actual product context — this is content work, not engineering.

**Day 2 — Prompt updates.**

- Strategist now proposes `phase`-appropriate stage mixes (heavy pull/explain in buildup, push at launch, reinforce post-launch).
- Content reads its assigned `stage` and adapts tone accordingly.
- Verify side-by-side: a `pull` post and a `push` post for the same campaign read distinctly different.

**Exit criteria.** Generated calendars carry phase + stage tags. Drafts in different stages are visibly different.

---

### Phase 4 — Approval Flow in Chat (3–4 days)

**Day 1 — JSX approval card.**

- `cards/approval.tsx` using Chat SDK primitives: title, preview, channel hint, three buttons (Approve, Request changes, Reject).
- Render in both Slack (Block Kit output) and Discord (embed output) via Chat SDK adapters.

**Day 2 — Action handlers.**

- `onAction('approve')`, `onAction('request_changes')`, `onAction('reject')` in the Manager.
- Each calls `POST /api/approvals/:id` with the actor's user ID extracted from the action context.
- Two-approver mode: configurable per channel via `settings` table; if enabled, first approval flags the content but doesn't transition until second approval lands.

**Day 3 — Modal for "request changes."**

- Chat SDK modal prompts for a change reason.
- Reason attached to the rejection record, returned to the Content sub-agent on the next revision so the agent knows what to fix.

**Day 4 — End-to-end smoke + Realtime.**

- Drive a real flow on both platforms.
- Subscribe the admin UI to Supabase Realtime on `content_items` and `approvals`. When a Slack approval lands, the admin UI updates within ~1 second.

**Exit criteria.** Both platforms drive content from draft to approved with full audit trail. Admin UI updates live.

---

### Phase 5 — First Adapter (Internal Blog) + Distributor Wiring (5–6 days)

**Day 1 — Distributor scaffold.**

- BullMQ worker in `apps/distributor` listening on the `publish` queue.
- Connects to Upstash Redis and the Next.js API via cp-client.
- Logs received jobs without acting on them.

**Day 2 — Publish-job API.**

- `POST /api/publish-jobs` (refuses if content not approved — both API check and DB trigger).
- `PATCH /api/publish-jobs/:id` (status updates from the Distributor).
- `GET /api/publish-jobs/:id`.
- Integration test for the rejection path — try to enqueue an unapproved item, verify 409.

**Day 3 — Distributor-client tool.**

- Manager's `schedule_publish` tool calls the publish-jobs endpoint.
- Manager fires a best-effort HTTP ping to the Distributor for low latency; Distributor's poller is the correctness fallback.

**Day 4 — Internal blog adapter.**

- `internal-blog.ts` adapter: status flip plus public-route exposure.
- `app/blog/[slug]/page.tsx` Server Component reads Postgres, renders the Markdown.
- Slug generation, OG metadata, basic styling.

**Day 5 — Status callback chain.**

- Distributor PATCHes `publish_jobs` to `succeeded`.
- Calls `POST /api/thread-notify` with `{ thread_ref, message }`.
- Next.js API forwards to the Manager's `thread-poster` endpoint.
- Manager posts into Slack/Discord thread via Chat SDK.

**Day 6 — E2E and tests.**

- Full flow: plan → draft → approve → publish → URL appears in thread → blog post live at `/blog/[slug]`.
- Negative test: try to enqueue unapproved content via direct API call, verify 409 + DB trigger fires.

**Exit criteria.** Approved blog post appears at a public URL within 30 seconds; the success message lands in the originating thread.

---

### Phase 6 — Social Adapters: LinkedIn + X (5–7 days)

**Day 1 — Adapter contract formalization.**

- Define `PublishingAdapter<TPayload, TResult>` interface in `shared-types`.
- Refactor `internal-blog` to implement the contract.
- Adapter registry in `distributor/src/adapters/index.ts`.

**Day 2 — LinkedIn adapter.**

- Use the LinkedIn Marketing API approval received in Phase 0.
- `publish()` for company-page UGC posts.
- `retract()` via DELETE on the post URN.
- Test with a real sandbox post on your LinkedIn company page.

**Day 3 — X adapter, single posts.**

- v2 `POST /2/tweets` for single posts.
- OAuth 2.0 PKCE flow for the company X account.
- Verify your tier's write quota covers expected volume.

**Day 4 — X adapter, threads.**

- Sequential posting with `in_reply_to_tweet_id` chaining.
- If tweet N fails, halt and report partial success in `error` and a custom `partial_external_ids` field.
- Test with a real 5-tweet thread.

**Day 5 — Scheduling.**

- BullMQ delayed jobs with `delay: scheduled_at - now`.
- Test 10-minute, 1-hour, 24-hour delays. Verify firing within 60-second tolerance.

**Day 6 — Rate limits, caps, and the kill switch.**

- `settings.channel_caps` config: `{ linkedin: 5, x: 20, ... }` posts per day.
- Distributor checks `count(publish_jobs where channel = ? and status in succeeded and created_at > today())` before scheduling. Defers if over.
- `settings.kill_switch`: when true, distributor drains in-flight jobs and stops picking new ones.

**Day 7 — Admin UI for caps and kill switch.**

- `(admin)/settings/page.tsx` with the kill switch (big red button) and per-channel cap inputs.
- TanStack Query mutation invalidates settings cache; Distributor reads at job start.

**Exit criteria.** Real posts go live on LinkedIn and X. Threads chain correctly. Schedules fire on time. Caps enforce. Kill switch halts publishing within one worker cycle.

---

### Phase 6.5 — Visual Asset Generation (10–14 days)

**Day 1 — Schema and storage.**

- `assets` table with Drizzle migration.
- Supabase Storage bucket `assets/` with appropriate policies.
- Helper for generating signed-URL previews (used in approval cards).

**Day 2 — Templating service evaluation and setup.**

- Spend a half-day choosing between Bannerbear and Placid based on which template UI your designer prefers.
- Get API key. Designer creates first 2 templates (announcement, quote highlight). Test with curl before writing code.

**Day 3 — Asset sub-agent scaffold.**

- New sub-agent in the Manager with system prompt for visual reasoning.
- Tools: `read_visual_memory`, `generate_background`, `render_template`, `create_asset`.
- Wire into orchestrator as a tool the Content sub-agent can request.

**Day 4 — Replicate integration.**

- `generate_background` tool calls Replicate (FLUX recommended for general use, Ideogram if typography matters).
- Output uploaded to Supabase Storage.
- Constrained prompts driven by `brand/visual.md`.

**Day 5 — Template renderer integration.**

- `render_template` tool: Bannerbear/Placid API call with template ID + field values + background URL.
- Final PNG stored in Supabase Storage.
- `assets` row created with status `draft` and storage path.

**Day 6 — Approval card with image preview.**

- Extend approval card JSX to render image + copy side-by-side.
- Signed URL generation for the preview (Slack and Discord need direct image URLs).
- Test rendering on both platforms.

**Day 7 — Asset attachment in adapters.**

- LinkedIn adapter: fetch approved asset from Supabase Storage, upload via LinkedIn assets endpoint, get URN, attach to UGC post.
- X adapter: fetch asset, upload via v1.1 media endpoint (yes, still v1.1 for media), attach `media_ids` to v2 tweet.

**Day 8–10 — Visual prompt iteration.**

- Real campaigns with the asset sub-agent. Visual review with the designer.
- Tighten `brand/visual.md` constraints. Iterate on prompts and template field mappings.
- Expect this to take longer than the equivalent text iteration in Phase 3.

**Day 11–14 — Template expansion and polish.**

- Add stat highlight, sequence, reinforcement, push, recap templates.
- Each template gets a test run with the asset sub-agent + designer review.
- Brand-consistency check across 10 sample posts in a side-by-side review.

**Exit criteria.** A published X post shows the generated poster attached. Brand consistency holds across 10 sample posts. The designer signs off on template quality.

---

### Phase 7 — Email and CRM Adapter (4–5 days)

**Day 1 — Decision and OAuth.**

- HubSpot if your team uses HubSpot for CRM; otherwise Mailchimp.
- OAuth flow + scope setup. Test token fetch end-to-end.

**Day 2–3 — Email adapter.**

- `publish()` creates a broadcast, attaches audience, sends.
- HubSpot Marketing Email API or Mailchimp campaigns endpoint.
- Test sends to a tiny audience first.

**Day 4 — Metrics fetch.**

- `fetchMetrics()` returns opens, clicks, unsubs.
- BullMQ repeatable job: 24h after each broadcast, pull metrics into `metrics` table.

**Day 5 — Content type wiring.**

- Verify the Content sub-agent produces good email bodies given a brief.
- Email-specific brand memory: subject-line guidelines, send-time heuristics in `memory/channel-sops/email.md`.

**Exit criteria.** A real email broadcast ships end-to-end. Open/click counts populate within 24 hours.

---

### Phase 8 — Analyst Sub-Agent and Metrics Rollups (4–5 days)

**Day 1 — GA4 adapter.**

- Service account credentials, GA4 Data API.
- `runReport` filtered by `utm_campaign = ?` matching campaign slugs.
- Quota-aware caching to avoid hitting the daily quota.

**Day 2 — Rollup queries.**

- SQL views in Supabase:
  - `campaign_performance` — per-campaign aggregate.
  - `stage_performance` — per-stage aggregate.
  - `channel_performance` — per-channel aggregate.
- Keep these as raw SQL in `infra/supabase/views.sql`.

**Day 3 — Analyst sub-agent.**

- System prompt encoding your Step 6 methodology: what drives clicks, what brings users, what people engage with.
- Tools: `query_campaign_performance`, `query_stage_performance`, `read_learnings`, `write_learnings`.
- First report runs — iterate the prompt until it's actually useful prose, not just numbers.

**Day 4 — Weekly cron.**

- BullMQ repeatable job, Monday 9 AM Asia/Kathmandu.
- Triggers analyst with "summarize last week, post to #marketing."
- First few runs need prompt tuning.

**Day 5 — On-demand reports + learnings loop.**

- `@marketing report on the launch` triggers analyst with a campaign filter.
- Analyst writes findings to `learnings/{yyyy-mm}.md`.
- Strategist reads recent learnings on every planning invocation — verify the loop closes by checking that recent insights influence next week's brief.

**Exit criteria.** Monday cron lands a useful report unprompted. Strategist's planning is visibly informed by recent learnings.

---

### Phase 9 — Syndication and Polish (3 days)

**Day 1 — Syndication notification.**

- After internal-blog publish, post a "Copy for Medium" card to the originating thread with formatted Markdown including `<rel=canonical>` link.
- Same pattern reusable for Substack, Hashnode, Dev.to.

**Day 2 — Per-content rate limits and audit-log UI.**

- 24-hour rate limit on republishing same content to same channel — DB constraint + API check.
- `(admin)/audit-log/page.tsx` with TanStack Table, filterable by actor / entity / action / date range.

**Day 3 — Dashboard and final UX polish.**

- Grafana dashboard: queue depth, publish success rate, approval latency p50/p95, adapter error rate, daily-cap utilization.
- Approval queue: badge counts, sort by age, batch-approve for the same campaign.

**Exit criteria.** All three landed and tested.

---

### Phase 10 — Production Hardening (5 days)

**Day 1 — Disaster drills.**

- Kill the Manager mid-conversation; verify thread state survives via Redis.
- Kill the Distributor mid-job; verify BullMQ retries on restart.
- Kill the Next.js app; verify Vercel auto-recovers.
- Document recovery in a runbook.

**Day 2 — Credential rotation.**

- Rotate every external token in Doppler. Verify adapters pick up new credentials without restart. Fix any that don't.
- Same for Supabase service-role key rotation.

**Day 3 — Backups and DR.**

- Supabase PITR is on by default; verify and document restore procedure.
- Daily `pg_dump` to Supabase Storage as belt-and-suspenders.
- Memory directories backed up via the git remote.

**Day 4 — Load smoke test.**

- 50 publish jobs in 5 minutes across mixed channels.
- Verify queue depth stays sane, rate limits engage, no duplicate publishes.

**Day 5 — End-to-end campaign dry run.**

- Plan, draft, approve, publish to four channels (blog, LinkedIn, X, email), generate report.
- Time the full cycle. Fix anything that looks wrong.

**Exit criteria.** A complete campaign runs without intervention beyond approval clicks.

---

### Phase 11 — Learning Loop (3–4 days)

The knowledge base. Lets the AI retrieve and reuse what worked. This is **retrieval-augmented generation, not real model learning** — the model weights don't change. But to your team it'll look and feel like the system is getting smarter, because every new draft is grounded in your actual past wins instead of generic LLM priors.

**Important caveat — capture starts earlier.** The feedback capture table below (`agent_feedback`) must be wired into the approval flow in **Phase 4**, not here. You cannot backfill the difference between "what the AI drafted" and "what the human approved" after the fact — if you don't capture it at approval time, it's gone forever. This is the single most important data asset for any future fine-tuning work, so the table and write path land in Phase 4, and Phase 11 only adds the retrieval layer on top.

**Day 1 — Outcomes table and metrics ingestion.**

- New table `outcomes` (separate from `metrics`, which stays as raw time-series): `id, content_id, channel, window (7d|30d|90d), impressions, clicks, ctr, conversions, engagement_rate, computed_at`. One row per content × channel × window, recomputed by a nightly job.
- Nightly cron in `apps/distributor` rolls `metrics` rows up into `outcomes` rows. Idempotent — safe to re-run.
- Drizzle-Zod schemas for `outcomes` exported from `packages/db`.

**Day 2 — pgvector and the embedding pipeline (build it generic).**

The v1 design used a content-specific `content_embeddings` table. The current plan supersedes that with a single generic `embeddings` table so the same pipeline serves every future RAG use case (brand docs, product docs, rejected drafts, playbooks, external sources) without a re-architecture each time.

- Enable `vector` extension in Supabase (one SQL line).
- New table `embeddings` (deliberately generic, not content-specific):
  ```
  embeddings
    id (uuid, pk),
    source_type (enum: content | brand_doc | product_doc | rejected_draft | playbook | external),
    source_id (text — content_id, file path, or external URL),
    chunk_index (int — 0 for whole-doc, >0 for chunked),
    text (the chunked text that was embedded — kept for debugging and re-display),
    embedding vector(1536),
    metadata (jsonb — channel, stage, outcomes_summary, etc),
    model, embedded_at
  ```
  Composite unique index on `(source_type, source_id, chunk_index)`.
- On every `content_items.status = 'approved'` transition, enqueue a BullMQ job that calls the embedding API (OpenAI `text-embedding-3-small` is cheap and adequate; Voyage if you want best-in-class) and writes a row with `source_type = 'content'`, `source_id = content_id`, `chunk_index = 0`.
- Backfill job for existing approved content.
- Index: `CREATE INDEX ON embeddings USING ivfflat (embedding vector_cosine_ops) WHERE source_type = 'content'` — partial indexes per source_type stay efficient as the table grows mixed.
- **Why generic:** the same table later holds embeddings for `apps/manager/memory/brand/*.md`, `memory/product/*.md`, rejected drafts from `agent_feedback`, approved playbooks, and any external sources you ingest. One pipeline, one retrieval function, many tools on top. Adding a new RAG use case becomes a 1-day task instead of a re-architecture.

**Day 3 — The retrieval tools and prompt wiring.**

- One generic retrieval primitive (server-side, not exposed to agents directly):
  ```
  retrieve({ sourceType, queryText, filters?, limit? })
    -> Array<{ source_id, chunk_index, text, metadata, similarity }>
  ```
- Tools exposed to sub-agents are thin wrappers over `retrieve`, each with the right filters and join shape:
  ```
  findSimilarContent({ topic, channel?, minCTR?, minEngagement?, limit? })
    -> Array<{ content_id, title, body_md, outcomes, published_url }>
    // sourceType='content', joins outcomes, filters by performance

  findBrandGuidance({ topic, limit? })
    -> Array<{ source_id, text, metadata }>
    // sourceType='brand_doc', no join, returns chunks verbatim

  findCommonMistakes({ topic, channel?, limit? })  // optional, after ~50 rejections exist
    -> Array<{ ai_draft_md, reason, edit_distance }>
    // sourceType='rejected_draft', joins agent_feedback
  ```
- Update Strategist and Content system prompts in `packages/prompts` so they call `findSimilarContent` and `findBrandGuidance` **before** drafting. Prompt instruction: *"Before generating, retrieve 3-5 similar past posts using `findSimilarContent` and any relevant brand guidance with `findBrandGuidance`. Cite the sources you drew from in a `<rationale>` block. Prefer patterns from posts that exceeded median CTR for the channel."*
- Add the rationale block to the approval card so humans can see what the AI was drawing from.

**Day 4 — Feedback retrieval surface (capture is already in Phase 4).**

- Admin UI page `/insights`: "What's working" — top 10 outcomes by channel, with the playbook-style summary the Analyst proposes (read-only for now; human-approved playbook updates are deferred to v2).
- Read endpoint `GET /api/insights/top-performers?channel=&window=`.
- Optional: a `humanApproved` filter on `findSimilarContent` so the agent can prefer drafts that were approved without edits over drafts that were heavily rewritten — those are your highest-quality training signals later.

**The Phase 4 add-on (do not skip).**

When wiring approvals in Phase 4, also create:

- Table `agent_feedback`: `id, content_id, revision_id, ai_draft_md, human_final_md, decision (approved|changes_requested|rejected), edit_distance, decided_by, decided_at, reason`.
- On every approval action, write a row capturing the AI's original draft, the final human-edited version, and the decision. Compute `edit_distance` (Levenshtein on the markdown) so you can later filter for "minimal-edit approvals" — your cleanest training pairs.
- This is the dataset you'll use in 6–12 months to fine-tune a small model on your brand voice. Without it, fine-tuning is impossible. With it, you have a growing, dated, labeled corpus from day one at zero ongoing cost.

**Exit criteria.** A new draft request triggers a `findSimilarContent` call before generation; the resulting draft cites past posts in its rationale; `/insights` shows top performers per channel; `agent_feedback` is accumulating rows on every approval (verified by integration test).

**What this phase explicitly does NOT do.**

- No automatic playbook editing. The Analyst can *propose* a playbook diff in `/insights`, but a human approves before it's written to `apps/manager/memory/playbooks/`.
- No fine-tuning. That's a separate, later effort that depends on `agent_feedback` reaching ~1,000 minimal-edit approvals.
- No self-modifying prompts. Prompts stay in `packages/prompts` under git review.

---

## 5.5. Progress Tracker

Mark `[x]` as items complete. Day numbers refer to the plan above; reorder freely if work happens out of sequence. Update **Status** and **Last touched** at the top of each phase.

### Pre-flight (decisions from §7)

- [ ] HubSpot vs Mailchimp chosen
- [ ] Bannerbear vs Placid chosen
- [ ] Single vs two-approver policy chosen
- [ ] Project codename chosen
- [ ] Defer Phase 6.5 to v2? (yes / no)

### Phase 0 — Foundation

**Status:** in progress · **Last touched:** 2026-04-30

- [x] pnpm workspace scaffold matching §2 structure
- [x] Supabase project provisioned (ref `ftpmzxkaiaxxcbnvqauy` "Agentic Marketing", Singapore); keys in `.env`
- [x] Drizzle config pointed at Supabase (`drizzle.config.ts`)
- [x] First migration applied (`packages/db/drizzle/0000_lowly_gideon.sql`, 9 tables + 12 enums)
- [x] `apps/web` connects to Supabase locally (verified by live API smoke test)
- [x] Stub BullMQ producer + consumer (`apps/distributor`)
- [ ] Upstash Redis provisioned
- [ ] Doppler wired into all three apps (using `.env` for now)
- [ ] Grafana Cloud + OpenTelemetry sample trace lands
- [ ] LinkedIn Marketing API access request submitted
- [ ] X API tier verified
- [ ] Slack + Discord bot apps registered
- [ ] **Exit:** all services up; sample trace in Grafana; LinkedIn application submitted

### Phase 1 — Control Plane Core

**Status:** complete · **Last touched:** 2026-05-01

- [x] Day 1 — Drizzle schema for all §3 tables (`packages/db/src/schema.ts`)
- [x] Day 1 — first migration applied to live Supabase via `pnpm db:migrate`
- [x] Day 1 — drizzle-zod schemas exported from `packages/db` (`packages/db/src/zod.ts`)
- [x] Day 2 — RLS policies applied (`infra/supabase/policies.sql`)
- [x] Day 2 — `BEFORE INSERT` trigger on `publish_jobs` enforcing approval invariant (applied + verified)
- [x] Day 2 — Trigger verified by `packages/db/scripts/verify-publish-gate.mjs` (4/4 checks pass)
- [x] Day 3 — `lib/state-machine.ts` with `canTransition*` + 11 unit tests passing
- [x] Day 3 — `lib/audit.ts` higher-order audit wrapper (`withAudit`)
- [x] Day 4 — campaign Route Handlers (POST/GET, GET-by-id)
- [x] Day 4 — content Route Handlers (POST/GET list/PATCH/submit); `GET /api/content?campaignId=&status=&type=&limit=&offset=` with total count; `cp.listContent()` added
- [x] Day 4 — publish-jobs Route Handlers: `GET /api/publish-jobs?contentId=&status=&channel=&limit=&offset=` list endpoint; `cp.listPublishJobs()` + `cp.getPublishJob()` added
- [x] Day 4 — approvals list: `GET /api/approvals?pending=true` returns all undecided approvals joined with content title/type/stage + age minutes; `cp.getPendingApprovals()` added
- [x] Day 4 — approval Route Handler with state-machine validation
- [x] Day 4 — audit-log Route Handler (paginated GET with filters)
- [x] Day 4 — publish-jobs handler with publish-gate check (PublishGateError -> 409, smoke-tested live)
- [x] Day 5 — Supabase Auth magic-link flow (`/login` form + `/auth/callback` route exchanges code for session cookie)
- [x] Day 5 — `proxy.ts` redirects unauthenticated users (Next 16 `proxy` convention, not `middleware`)
- [x] Day 5 — `X-Internal-Token` for OpenClaw service-role calls (`lib/internal-auth.ts`, constant-time compare)
- [x] Day 6 — `(admin)/campaigns` list page: redesigned with status/phase filter links, content count + approved/published breakdown per campaign, phase/status badges; `GET /api/campaigns?status=&phase=` filter support added; `cp.listCampaigns({ status?, phase? })` updated
- [x] Day 6 — `(admin)/campaigns/[id]` detail page
- [x] Day 6 — TanStack Query create-campaign mutation wired in `NewCampaignForm` (Provider in root layout)
- [x] Day 7 — Live-DB integration tests in `apps/web/test/lifecycle.test.ts` (preferred Testcontainers pattern; deferrable since Supabase is the canonical environment)
- [x] Day 7 — Integration tests: full lifecycle, publish-gate rejection, 24h republish guard (3/3 passing against live Supabase)
- [x] Day 7 — Vitest in CI (`.github/workflows/ci.yml`: typecheck + unit always, integration when `DATABASE_URL` secret set, build with stubs)
- [x] **`PATCH /api/campaigns/:id`** added (name, phase, status, briefMd, calendarJson, startDate, endDate) with audit wrapper + agent access; `cp.patchCampaign()` in cp-client; Strategist `write_calendar` now persists `calendarJson` to DB
- [x] **Exit:** human-via-API can drive draft → in_review → approved → publish-gate accepts; UI form creates campaigns; publish_jobs refuses unapproved (live trigger + 409 from API); every change in audit log

### Phase 2 — Messaging Surface

**Status:** code complete; pending Slack/Discord app registration + env vars · **Last touched:** 2026-04-30

- [x] Day 1 — `@slack/bolt` + `discord.js` added to `apps/manager/package.json` (run `pnpm install` to hydrate)
- [x] Day 1 — `onNewMention` handler wired in `apps/manager/src/index.ts` (routes to orchestrator; echoes on error)
- [x] Day 1 — Redis state persists thread history via `ioredis` (key `thread:{threadRef}`, 7-day TTL)
- [ ] Day 2 — Slack scopes + event subscriptions; OAuth install (external: register Slack app, set `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`)
- [ ] Day 2 — Discord intents + slash command registration (external: register Discord app, set `DISCORD_BOT_TOKEN`)
- [ ] Day 2 — `@marketing hello` works in both platforms
- [x] Day 3 — `thread_ref` format defined (`slack:C{channelId}:T{ts}` / `discord:C{channelId}:T{messageId}`) in `apps/manager/src/bot/`
- [x] Day 3 — `threadPoster.ts` posts to either platform from a thread_ref (`apps/manager/src/thread-poster.ts`)
- [x] Day 3 — Manager restart preserves thread state (Redis `ioredis` with `lazyConnect`)
- [ ] **Exit:** mention works on both platforms; thread state survives restart; thread-poster works

### Phase 3 — Strategist and Content Sub-Agents

**Status:** code complete; OTel spans live; smoke tests pending `ANTHROPIC_API_KEY` · **Last touched:** 2026-05-01

- [x] Day 1 — Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) already in `apps/manager/package.json`
- [x] Day 1 — `runOrchestrator` ToolLoopAgent with 9 tools: `run_strategist`, `run_content`, `run_analyst`, `run_distributor`, `run_asset`, `clarify`, `list_campaigns`, `get_pending_approvals`, `check_publish_job` (`apps/manager/src/orchestrator.ts`); prompt updated with decision rules for direct-lookup vs sub-agent routing
- [x] Day 1 — `onNewMention` routes to `runOrchestrator` in `apps/manager/src/index.ts`
- [x] Day 2 — `loadMemory()` / `loadMemoryDir()` / `buildBaseMemory()` helpers (`apps/manager/src/memory.ts`)
- [x] Day 2 — `cp-client` wired into all sub-agent tool `execute()` callbacks
- [x] Day 3 — Strategist sub-agent prompt + tools (`apps/manager/src/sub-agents/strategist.ts`): `read_memory`, `read_past_learnings`, `create_campaign`, `update_campaign`, `write_calendar`
- [ ] Day 3 — Strategist passes "plan a launch" smoke test (needs `ANTHROPIC_API_KEY` + live Supabase)
- [x] Day 4 — Content sub-agent prompt + tools (`apps/manager/src/sub-agents/content.ts`): `read_brief`, `read_memory`, `create_content`, `revise_content`, `submit_for_review`
- [ ] Day 4 — Content passes blog + X-thread smoke test
- [ ] Day 5–6 — prompt iteration on real campaigns (fill `memory/brand/voice.md` + `memory/brand/icp.md`)
- [x] Day 5–6 — prompts versioned in `packages/prompts/src/` (strategist, content, analyst, asset, orchestrator)
- [x] Day 7 — OpenTelemetry spans on sub-agent + tool calls (`apps/manager/src/telemetry.ts`); `withSpan` wraps orchestrator + every `execute()` callback; OTLP HTTP exporter to Grafana Cloud; no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` not set
- [ ] Day 7 — Slack-to-DB trace visible in Grafana
- [ ] Day 7 — happy-path smoke tests
- [ ] **Exit:** `@marketing plan a campaign` produces brief in your voice; first-draft posts mostly pass review

### Phase 3.5 — Marketing Methodology Integration

**Status:** schema done; prompts updated; memory scaffolded; side-by-side test pending real campaigns · **Last touched:** 2026-04-30

- [x] Day 1 — `phase` enum on campaigns + `stage` enum on content_items — already in schema from Phase 1 (`packages/db/src/schema.ts`)
- [x] Day 1 — `memory/product/state.md` scaffolded; `memory/product/positioning.md` scaffolded (fill with real product context)
- [x] Day 2 — Strategist updated with phase-to-stage mix rules (40/40/20 buildup, 20/20/20/40 launch, 10/30/40/20 post_launch) in `packages/prompts/src/strategist.ts`
- [x] Day 2 — Content updated with per-stage tone guidance + phase context in `packages/prompts/src/content.ts`
- [ ] Day 2 — side-by-side review: pull vs push posts read distinctly (needs real prompt run)
- [ ] **Exit:** calendars carry phase + stage tags; stages produce visibly different drafts

### Phase 4 — Approval Flow in Chat

**Status:** code complete; live test on both platforms pending Slack/Discord registration · **Last touched:** 2026-05-01

- [x] Day 1 — `apps/manager/src/cards/approval.ts` — Slack Block Kit card (3 buttons: Approve, Request changes, Reject) + Discord embed with slash-command instructions
- [x] Admin-UI approval row with Approve / Request changes / Reject buttons + age label; `useDecideApproval` mutation invalidates campaign + approval queries
- [x] Day 2 — Slack `onAction` handlers: `approval_approve`, `approval_changes` (modal), `approval_reject` call `POST /api/approvals/:id` with actor's user ID (`apps/manager/src/bot/slack.ts`)
- [x] Day 2 — Discord slash commands: `/approve`, `/reject`, `/changes` registered on startup; `InteractionCreate` handler calls CP client (`apps/manager/src/bot/discord.ts`)
- [x] Day 2 — two-approver mode: `approval_policy` key in settings table; `PATCH /api/settings` persists it; Settings page exposes Single / Two-approver toggle
- [x] Day 3 — "request changes" modal in Slack opens via `views.open`; reason stored in approval row
- [x] Day 3 — `get_revision_reason` tool in Content sub-agent fetches `GET /api/approvals?contentId=...` for latest `changes_requested` reason; `apps/web/app/api/approvals/route.ts` added
- [x] Day 3 — Content sub-agent `submit_for_review` now posts approval card to originating thread via `postToThread` callback; orchestrator passes `threadRef` + `cp.notifyThread` callback; platform detected from `threadRef` prefix to choose Slack Block Kit vs. Discord embed vs. plain text
- [ ] Day 4 — end-to-end smoke on both platforms (needs registered apps + env vars)
- [x] Day 4 — Supabase Realtime subscription (`apps/web/lib/realtime-invalidator.tsx`) invalidates TanStack Query keys; mounted in admin layout; extended to also invalidate `insights` on `outcomes` table changes
- [ ] **Exit:** both platforms drive draft → approved with audit trail; admin UI live-updates

### Phase 5 — First Adapter (Internal Blog) + Distributor Wiring

**Status:** publish loop end-to-end works; thread-notify fully wired to Manager · **Last touched:** 2026-05-01

- [x] Day 1 — BullMQ worker in `apps/distributor` listening on `publish` queue
- [x] Day 2 — `POST /api/publish-jobs` (refuses unapproved; live-tested 409)
- [x] Day 2 — `PATCH /api/publish-jobs/:id` for status updates (relaxed externalUrl validator to accept `/blog/...` paths)
- [x] Day 2 — integration test: 409 on unapproved enqueue (`lifecycle.test.ts`)
- [x] Day 3 — `apps/web/lib/publish-queue.ts` enqueues to BullMQ on insert (best-effort; DB row is source of truth)
- [x] Day 4 — internal-blog adapter (`apps/distributor/src/adapters/internal-blog.ts`)
- [x] Day 4 — `app/blog/[slug]/page.tsx` Server Component renders Markdown
- [x] Day 4 — slug derivation (`slugify(title) + 6-char suffix from contentId`)
- [x] Day 4 — OG metadata (title, description, openGraph, twitter card, canonical) + polished styling with inline Markdown renderer (`apps/web/app/blog/[slug]/page.tsx`)
- [x] Day 5 — `/api/thread-notify` forwards to Manager `POST /forward-notify`; Manager HTTP server (`apps/manager/src/http-server.ts`) on `MANAGER_HTTP_PORT` (default 3001) receives and posts via `ThreadPoster`
- [x] Day 6 — full draft→approve→publish→/blog E2E verified by `packages/db/scripts/smoke-publish.mjs` (all 7 checks pass)
- [x] Day 6 — negative test: direct API enqueue of unapproved fails (covered by `lifecycle.test.ts`)
- [ ] **Exit (partial):** approved blog post live within ~1s of enqueue; success message goes to thread once Manager exists

### Phase 6 — Social Adapters: LinkedIn + X

**Status:** code complete; live credential test pending · **Last touched:** 2026-05-01

- [x] Day 1 — `PublishingAdapter<TPayload>` interface in `packages/shared-types/src/index.ts`
- [x] Day 1 — `InternalBlogAdapter` implements interface; adapter registry updated (`apps/distributor/src/adapters/index.ts`) with env-gated LinkedIn + X registration
- [x] Day 2 — `LinkedInAdapter` fully implemented (`apps/distributor/src/adapters/linkedin.ts`): `publish()` → `POST /v2/ugcPosts` (text-only + image with `registerUpload` → PUT); `retract()` → `DELETE /v2/ugcPosts/:encoded`; `fetchMetrics()` → `organizationalEntityShareStatistics`
- [ ] Day 2 — sandbox post on company page works (needs `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_ORGANIZATION_URN`)
- [x] Day 3 — X v2 adapter fully implemented (`apps/distributor/src/adapters/x.ts`): single-post + thread chaining via `in_reply_to_tweet_id`; OAuth 1.0a HMAC-SHA1 signing (`x-oauth.ts`) using Node.js built-in `crypto`; media upload via v1.1 `upload.twitter.com` endpoint; `retract()` + `fetchMetrics()` (`public_metrics`)
- [ ] Day 3 — write quota verified for tier (needs live X credentials)
- [x] Day 4 — X thread chaining implemented; partial-failure handling: publishes N-1 tweets then throws with `{ publishedIds, partialUrl }` for caller recovery
- [ ] Day 4 — real 5-tweet thread succeeds (needs `X_API_KEY` + `X_API_KEY_SECRET` + `X_ACCESS_TOKEN` + `X_ACCESS_TOKEN_SECRET`)
- [x] Day 5 — BullMQ delayed jobs: `delay = scheduledAt - now` in `POST /api/publish-jobs`; `enqueuePublish` accepts `delayMs` (`apps/web/lib/publish-queue.ts`)
- [x] Day 6 — `settings.channel_caps` enforced in `apps/distributor/src/worker.ts` (channel-cap gate already live)
- [x] Day 6 — `settings.kill_switch` drains in-flight + halts new (kill-switch gate already live in worker)
- [x] Day 7 — `(admin)/settings/page.tsx` + `settings-form.tsx`: kill switch big-red-button, per-channel daily caps, approval policy toggle; `PATCH /api/settings` with audit wrapper
- [ ] **Exit:** real LinkedIn + X posts live; threads chain; schedules fire on time; caps + kill switch work

### Phase 6.5 — Visual Asset Generation

**Status:** code complete for Days 1–7; designer/template sourcing + live smoke test pending · **Last touched:** 2026-05-01

- [x] Day 1 — `assets` table already in schema (`packages/db/src/schema.ts`) — no new migration needed
- [x] Day 1 — Supabase Storage signed-URL helper (`apps/web/lib/supabase/storage.ts`): `getSignedAssetUrl`, `uploadAsset`, `deleteAsset`; `POST /api/assets`, `GET /api/assets`, `GET /api/assets/:id` (includes signed URL), `PATCH /api/assets/:id`
- [ ] Day 2 — Bannerbear/Placid chosen; first 2 templates from designer
- [ ] Day 2 — curl smoke test of templating API
- [x] Day 3 — Asset sub-agent fully wired: `read_visual_memory`, `generate_background`, `render_template`, `create_asset` all call real implementations; `run_asset` in orchestrator wraps with OTel span
- [x] Day 4 — `generate_background` tool (`apps/manager/src/image-gen.ts`): Replicate SDXL API with `poll()` loop (2 min timeout, 2s intervals); JPEG/PNG buffer download + `uploadAsset()` to Supabase Storage; aspect ratio support (square/portrait/landscape)
- [x] Day 4 — `asset-uploader.ts`: downloads public URL (Replicate CDN / Bannerbear) and PUTs to Supabase Storage REST API
- [x] Day 5 — `render_template` tool (`apps/manager/src/template-render.ts`): auto-selects Bannerbear (`BANNERBEAR_API_KEY`) or Placid (`PLACID_API_TOKEN`); `synchronous: true` for Bannerbear; upload result to Storage
- [x] Day 5 — `create_asset` tool calls `cp.createAsset()` → `POST /api/assets` with real DB row
- [x] Day 6 — Approval card renders image + copy side-by-side: `ApprovalRow` shows 160×160 `<Image>` preview alongside title/stage/age; expandable "Preview copy" section for `bodyMd`; approvals page fetches first asset per content item + signed URL server-side
- [x] Day 6 — Slack Block Kit card updated with `accessory.image` block when `assetSignedUrl` is present; Discord embed updated with `image.url`; `ApprovalCardData` carries `assetSignedUrl?` field
- [x] Day 6 — Content sub-agent auto-posts approval card to originating thread on `submit_for_review` (fetches approval ID + asset signed URL; posts Slack/Discord/plain card depending on `threadRef` prefix)
- [ ] Day 6 — signed URL verified in Slack + Discord approval cards (needs registered bots)
- [x] Day 7 — LinkedIn adapter accepts `assetSignedUrl` → registers + uploads via `registerUpload` then attaches as `IMAGE` media in UGC post
- [x] Day 7 — X adapter accepts `assetSignedUrl` → uploads via v1.1 media endpoint → attaches as `media_ids` to first tweet
- [ ] Day 8–10 — visual prompt iteration with designer
- [ ] Day 8–10 — `brand/visual.md` constraints tightened
- [ ] Day 11–14 — additional templates (stat, sequence, reinforcement, push, recap)
- [ ] Day 11–14 — 10-post brand-consistency review with designer
- [ ] **Exit:** published X post shows generated poster; designer signs off

### Phase 7 — Email and CRM Adapter

**Status:** full API implementations done; live test send pending credentials · **Last touched:** 2026-05-01

- [ ] Day 1 — HubSpot vs Mailchimp decided; OAuth scopes set up
- [ ] Day 1 — token fetch end-to-end works
- [x] Day 2–3 — `HubspotEmailAdapter` fully implemented: `POST /marketing/v3/emails` (Markdown → HTML with inline renderer) + `POST .../send`; `retract()` → cancel; `fetchMetrics()` → `/statistics/summary` (sent, delivered, opens, clicks, unsubscribes, bounces); env-gated on `HUBSPOT_ACCESS_TOKEN`
- [x] Day 2–3 — `MailchimpAdapter` fully implemented: `POST /campaigns` → `PUT .../content` → `POST .../actions/send`; Basic auth from `MAILCHIMP_API_KEY`; `retract()` → cancel-send; `fetchMetrics()` → `/reports/:id` (open_rate, click_rate, bounces, unsubscribes); env-gated on `MAILCHIMP_API_KEY`
- [ ] Day 2–3 — small-audience test send succeeds (needs live credentials)
- [x] Day 4 — BullMQ 24h-delayed metrics-fetch job (`apps/distributor/src/metrics-cron.ts`): `scheduleMetricsFetch` called in `runJob` after successful email publish; `startMetricsWorker` started alongside publish worker
- [x] Day 5 — `memory/channel-sops/email.md` scaffolded (both `apps/manager` and `apps/distributor`); `linkedin.md`, `x.md`, `internal-blog.md` SOPs added to `apps/manager/memory/channel-sops/`; `findBrandGuidance` now also scans `playbooks/`; README updated
- [ ] Day 5 — Content sub-agent produces good email bodies (needs real prompt run)
- [ ] **Exit:** real broadcast ships E2E; metrics populate within 24h

### Phase 8 — Analyst Sub-Agent and Metrics Rollups

**Status:** code complete including GA4 client + metrics API; live data pending GCP setup · **Last touched:** 2026-05-01

- [ ] Day 1 — GA4 service account + Data API access (external: GCP console); set `GA4_PROPERTY_ID` + `GA4_SERVICE_ACCOUNT_JSON`
- [x] Day 1 — `runReport` with `utm_campaign` filter + 1-hour in-memory cache (`apps/manager/src/ga4-client.ts`): JWT/OAuth 2.0 service-account signing via Node.js `crypto`; access-token cached separately; `query_campaign_performance` and `query_stage_performance` tools now call `runGA4Report`; gracefully degrades when env vars absent
- [x] **Extra** — `POST /api/metrics` + `GET /api/metrics` Control Plane endpoints (`apps/web/app/api/metrics/route.ts`); `cp.recordMetrics()` + `cp.getMetrics()` added to `cp-client`; metrics-cron TODO resolved — now calls `cp.recordMetrics()` after every successful email publish
- [x] Day 2 — SQL views: `campaign_performance`, `stage_performance`, `channel_performance` — already in `infra/supabase/views.sql`
- [x] Day 3 — Analyst sub-agent prompt + tools (`apps/manager/src/sub-agents/analyst.ts`): `query_campaign_performance`, `query_stage_performance`, `read_learnings`, `write_learnings`
- [ ] Day 3 — first reports produce useful prose (needs `ANTHROPIC_API_KEY` + live data)
- [x] Day 4 — Weekly cron: every Monday 09:00 Asia/Kathmandu (`apps/manager/src/cron.ts`); posts report to `MARKETING_SLACK_CHANNEL_ID` channel; Strategist reads `learnings/` on every plan via `read_past_learnings` tool
- [ ] Day 4 — cron posts report into #marketing (needs live Slack + Anthropic key)
- [x] Day 5 — `@marketing report on the launch` works on demand (orchestrator routes to `run_analyst`)
- [x] Day 5 — Analyst `write_learnings` tool writes to `memory/learnings/{yyyy-mm}.md`
- [x] Day 5 — Strategist reads learnings via `read_past_learnings` tool on every plan invocation
- [ ] **Exit:** Monday cron lands useful report unprompted; Strategist visibly informed by recent learnings

### Phase 9 — Syndication and Polish

**Status:** Days 1–3 complete; admin publish-jobs page added; Grafana dashboard pending external Cloud setup · **Last touched:** 2026-05-01

- [x] Day 1 — "Copy for Medium" syndication card: after `internal_blog` publish succeeds the Distributor calls `thread-notify` twice — first a ✅ success message, then a 📋 syndication checklist with canonical URL + per-platform paste instructions (Medium, Substack, Hashnode, Dev.to); `thread-notify` route now forwards to `Manager /forward-notify` (`apps/manager/src/http-server.ts`)
- [x] Day 2 — 24h republish rate limit: `POST /api/publish-jobs` checks for succeeded job on same content+channel within 24h, returns 409 `republish_too_soon`
- [x] Day 2 — `(admin)/audit-log` filterable table (`audit-log-table.tsx`): filter by actor kind, action, entity type, date range; pagination; expandable diff column
- [ ] Day 3 — Grafana dashboard (external: Grafana Cloud setup)
- [x] Day 3 — Approval queue: pending badge in nav (amber), age labels (days highlighted amber), oldest-first sort, batch-approve per campaign (`batch-approve-button.tsx`)
- [x] **Extra** — Publish jobs admin page (`(admin)/publish-jobs/page.tsx`): table of all publish jobs with content title, campaign, channel, status badge (with retry count), scheduled time, external URL / error; today's per-channel success counts; pagination; added to admin nav
- [ ] **Exit:** all three landed and tested

### Phase 10 — Production Hardening

**Status:** runbook + backup script done; kill drills + load smoke pending live services · **Last touched:** 2026-05-01

- [ ] Day 1 — Manager kill drill (thread state survives)
- [ ] Day 1 — Distributor kill drill (BullMQ retries)
- [ ] Day 1 — Next.js kill drill (Vercel auto-recovers)
- [x] Day 1 — runbook documented (`RUNBOOK.md`): kill switch, kill drill procedures, credential rotation, PITR + pg_dump restore steps, load smoke, full-campaign dry run checklist
- [ ] Day 2 — every external token rotated in Doppler; adapters pick up new creds
- [ ] Day 2 — Supabase service-role key rotation works
- [ ] Day 3 — Supabase PITR verified; restore procedure documented
- [x] Day 3 — daily `pg_dump` to Supabase Storage (`packages/db/scripts/pg-dump-backup.sh`); GitHub Actions cron workflow (`.github/workflows/backup.yml`) runs at 02:00 UTC
- [x] Day 3 — memory directories backed up via git remote (all `memory/` files committed to repo)
- [x] Day 4 — load smoke script: `packages/db/scripts/load-smoke.mjs` — creates 50 content items (approve → enqueue across round-robin channels), waits for drain (5 min timeout), asserts zero failures and no duplicate `externalId`s; run with `CP_BASE_URL=... INTERNAL_API_TOKEN=... node load-smoke.mjs`
- [ ] Day 4 — queue/rate-limit/no-duplicate verified under load (run `load-smoke.mjs` against staging)
- [ ] Day 5 — full dry run: plan → draft → approve → publish (4 channels) → report
- [ ] Day 5 — full-cycle time recorded
- [ ] **Exit:** complete campaign runs without intervention beyond approval clicks

### Phase 11 — Learning Loop

**Status:** complete (code) · **Last touched:** 2026-05-01

**Also shipped in this session:**
- [x] RLS policies for `agent_feedback`, `outcomes`, `content_embeddings` added to `infra/supabase/policies.sql`
- [x] `levenshtein.test.ts` — 11 unit tests (all passing); wired into CI (`ci.yml`)
- [x] `agent-feedback.test.ts` — 4 integration tests covering all three decision paths (approved/changes_requested/rejected) plus zero-edit path; runs with `DATABASE_URL` secret in CI

**Phase 4 add-on (must land with approvals, not here):**

- [x] `agent_feedback` table created (`ai_draft_md`, `human_final_md`, `decision`, `edit_distance`, `reason`) — `packages/db/src/schema.ts`; migration `0001_learning_loop.sql`
- [x] Approval Route Handler writes a row on every approve/changes_requested/rejected — `apps/web/app/api/approvals/[id]/route.ts`
- [x] `edit_distance` computed (Levenshtein on markdown) and stored — `packages/db/src/levenshtein.ts`; 11 unit tests in `packages/db/src/levenshtein.test.ts` (all passing)
- [x] Integration test: every decision path writes exactly one feedback row — `apps/web/test/agent-feedback.test.ts` (4 tests: approved with edit_distance, changes_requested null, rejected null, zero-edit approved)

**Phase 11 work:**

- [x] Day 1 — `outcomes` table + Drizzle-Zod schemas — `packages/db/src/schema.ts` + `zod.ts`
- [x] Day 1 — nightly rollup job in `apps/distributor` (idempotent) — `apps/distributor/src/outcomes-rollup.ts` (BullMQ repeatable, 02:00 UTC)
- [x] Day 2 — `vector` extension enabled on Supabase — `CREATE EXTENSION IF NOT EXISTS vector` in migration SQL
- [x] Day 2 — `content_embeddings` table + ivfflat cosine index — schema + migration SQL
- [x] Day 2 — embedding job triggered on `status = 'approved'` — `apps/distributor/src/embed-worker.ts` (BullMQ queue + HTTP server `POST /embed`); `apps/web/lib/embedding-queue.ts` calls it from the approval handler
- [x] Day 2 — backfill job for existing approved content — `backfillEmbeds()` exported from `embed-worker.ts`
- [x] Day 3 — `findSimilarContent` tool implemented — `apps/manager/src/find-similar.ts` (embeds topic locally, calls `POST /api/content/similar` with pgvector query)
- [x] Day 3 — Strategist + Content prompts updated to call it before drafting — `packages/prompts/src/strategist.ts` + `content.ts`; hard rule added; `<rationale>` block required
- [x] Day 3 — approval card shows the AI's `<rationale>` block: `parseRationale()` utility added to `packages/shared-types/src/rationale.ts`; Slack card shows a dedicated "🧠 AI Rationale" section block; Discord embed adds a "🧠 AI Rationale" field; admin `ApprovalRow` shows an expandable violet rationale section separate from the post copy; post copy preview is stripped of the rationale block so approvers see clean copy
- [x] Day 4 — `/insights` admin page (top performers per channel) — `apps/web/app/(admin)/insights/page.tsx`; added to admin nav; sort controls converted to link-based navigation so the page works without client-side JS
- [x] Day 4 — `GET /api/insights/top-performers` endpoint — `apps/web/app/api/insights/top-performers/route.ts`
- [x] Day 4 — `GET /api/content` list endpoint — `apps/web/app/api/content/route.ts`; cp-client `listContent()` added; Strategist + Content agents given `list_content` tool to check existing drafts before creating new items
- [x] Day 4 — `query_top_performers` + `query_metrics` tools added to Analyst sub-agent — `apps/manager/src/sub-agents/analyst.ts`; analyst prompt updated with accurate tool signatures
- [x] Day 4 — 8 unit tests for `parseRationale` utility — `apps/web/lib/parse-rationale.test.ts`; all 25 unit tests passing across `auth-allowlist`, `state-machine`, and `parse-rationale`
- [x] Day 4 — Campaign detail page enhanced: brief preview, calendar table, content item table with status/stage badges, status summary pills — `apps/web/app/(admin)/campaigns/[id]/page.tsx`
- [ ] **Exit:** new draft request triggers retrieval, draft cites past posts, `agent_feedback` accumulating on every approval (requires live Supabase with pgvector + `OPENAI_API_KEY`)

**Phase 11.1 — Generic embeddings refactor:**

**Status:** complete (code) · **Last touched:** 2026-05-01

- [x] New migration `0002_generic_embeddings.sql`: `embedding_source_type` enum (`content`, `brand_doc`, `rejected_draft`); `embeddings` table with `source_type`, `source_id`, `chunk_index`, `text`, `embedding`, `metadata`, `model`, `embedded_at`; composite unique constraint `(source_type, source_id, chunk_index)`; partial ivfflat indexes per `source_type`; data migration `INSERT … FROM content_embeddings ON CONFLICT DO NOTHING`; journal updated
- [x] `embedding_source_type` enum + `embeddings` table added to `packages/db/src/schema.ts`; `Embedding` + `NewEmbedding` types exported; `embeddingSourceTypeEnum` exported
- [x] `apps/distributor/src/embed-worker.ts` now writes to `embeddings` (`source_type='content'`) first; also writes to legacy `content_embeddings` during migration window (silent catch if already dropped); `embedText` extracted as named export; `backfillEmbeds` updated to left-join `embeddings` table
- [x] `POST /api/content/similar` updated to query `embeddings WHERE source_type='content'` with `source_id = content_items.id::text` join; no longer references `contentEmbeddings`
- [x] RLS: `alter table embeddings enable row level security` + `team_read_embeddings` select policy added to `infra/supabase/policies.sql`
- [x] `findBrandGuidance` implemented in `apps/manager/src/brand-guidance.ts`: loads `memory/brand/*.md` + `memory/channel-sops/*.md`; paragraph chunker; OpenAI embed with 5-min in-process cache; pure cosine similarity ranking; returns `{ source, text, similarity }[]`
- [x] `find_brand_guidance` tool added to both Strategist + Content sub-agents; prompts updated — Content must call `find_brand_guidance` AND `find_similar_content` before every first draft
- [ ] Drop `content_embeddings` after verifying data parity in staging (run `DROP TABLE content_embeddings;` after 0002 migration is applied)
- [ ] `findCommonMistakes` tool (defer until ~50+ `agent_feedback` rejections exist)

---

## 6. Total Estimate

| Phase                  | Days           | Cumulative                    |
| ---------------------- | -------------- | ----------------------------- |
| 0 — Foundation         | 2              | 2                             |
| 1 — Control Plane core | 5–7            | 7–9                           |
| 2 — Messaging surface  | 3              | 10–12                         |
| 3 — Sub-agents         | 5–7            | 15–19                         |
| 3.5 — Methodology      | 2              | 17–21                         |
| 4 — Approval flow      | 3–4            | 20–25                         |
| 5 — First adapter      | 5–6            | 25–31                         |
| 6 — Social adapters    | 5–7            | 30–38                         |
| 6.5 — Asset generation | 10–14          | 40–52                         |
| 7 — Email/CRM          | 4–5            | 44–57                         |
| 8 — Analyst            | 4–5            | 48–62                         |
| 9 — Polish             | 3              | 51–65                         |
| 10 — Hardening         | 5              | 56–70                         |
| 11 — Learning loop     | 3–4            | 59–74                         |
| **Total**              | **59–74 days** | **9–11 weeks solo full-time** |

Without Phase 6.5 (defer assets to v2): **6–8 weeks**. Without Phase 11 (defer the knowledge base): subtract another 3–4 days, but **the Phase 4 `agent_feedback` capture must still ship** — it's the only piece that can't be backfilled later.

---

## 7. Decisions Locked Before Phase 0

- **HubSpot or Mailchimp?** Decide based on existing CRM. Affects Phase 7.
- **Bannerbear or Placid?** Pick whichever your designer prefers. Affects Phase 6.5.
- **Single or two-approver for high-reach channels?** Affects Phase 1 schema and Phase 4 UX.
- **Project codename?** Trivial but needed for Slack workspace, GitHub org, Doppler config, Supabase project name.
- **Defer Phase 6.5 to v2?** Decide now, not mid-build. Saves 2–3 weeks if deferred.

---

## 8. Risks Worth Tracking

- **LinkedIn API access timing.** Submit application Day 1 of Phase 0; can take 1–4 weeks. Phase 6 is blocked without it.
- **X API tier sufficiency.** Verify Phase 0 day 2. If insufficient, choice is upgrade or accept lower volume.
- **Prompt iteration in Phase 3 and 6.5.** Coding is fast; prompt tuning is hard to predict. Mentally add 50% buffer to those phases.
- **Supabase Realtime quota.** Free tier is generous but has a connection cap; if the team grows past 10 concurrent admin UI users, may need a tier upgrade.
- **Bannerbear/Placid template quality.** Confirm with first 2 templates in Phase 6.5 day 2 — if they don't look professional, stop and resolve before sinking 10 more days.

---

## 9. The One Thing to Internalize

**Phase 1's Control Plane is the longest-pole investment.** The schema, state machine, RLS, audit log, and the approval invariant (both API check _and_ DB trigger) are what every later phase depends on. Take the full week. Don't compress it.

Every phase after that benefits from a solid Phase 1; every phase suffers if it's rushed. The state-machine bugs you don't catch in Phase 1 surface as approval bugs in Phase 4, publish-gate bugs in Phase 5, audit gaps in Phase 9 — all of which are harder to fix retroactively than to prevent up front.

---

_End of plan._
