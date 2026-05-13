# Production Runbook

Last updated: 2026-05-08

---

## Architecture today (post Phase 4 cutover)

**Single Next.js deployment.** `apps/manager` and `apps/distributor` were
deleted. All orchestration runs in-process inside `apps/web`; durable work
runs as **Vercel Workflows** under `apps/web/workflows/*.ts`. The
`workflow_engine` setting is `vercel` by default (`cloudflare` slot remains
for future). BullMQ + Redis is gone — the only Redis usage now is the chat
history KV in `apps/web/lib/chat/history-store.ts`.

### Sub-agents (8)

| Sub-agent       | Tool name         | What it does |
|-----------------|-------------------|---------------------------|
| Strategist      | `run_strategist`  | Campaign briefs + content calendars; reads KB + similar past wins. |
| Content         | `run_content`     | Drafts/revises content; reads KB, similar wins, and `findCommonMistakes` rejection patterns. |
| Asset           | `run_asset`       | Generates visual assets (still + video). |
| Art Director    | (called by asset) | Produces a visual concept brief grounded in KB `visual_reference` + product collections; rejects "anonymous floating cube" outputs via the vision-LLM judge. |
| Analyst         | `run_analyst`     | Performance reports + GA4. |
| Researcher      | `run_researcher`  | Audience / persona / competitor research; writes findings back to KB. |
| SEO             | `run_seo`         | Keyword research + on-page metadata; Serper.dev with stub fallback. |
| Experiment      | `run_experiment`  | Registers A/B experiments + picks winners from outcomes. |
| Lifecycle       | `run_lifecycle`   | Multi-step email sequences. |

### Modes (chat router)

| Trigger                   | Path |
|---------------------------|------|
| natural prompt or `/content`, `/asset`, `/seo`, `/research`, `/analyst` | one-shot sub-agent run, no campaign |
| `/workflow [channel] <prompt>` | single-post workflow (draft → asset → approval → publish) |
| `/goal <objective>`       | full goal-loop: plan → fanout → approvals → publish → measure → re-evaluate |

### Goal loop

`apps/web/workflows/goal-loop.ts`. Per iteration: budget check → plan →
parallel fanout → wait approvals → branch (publish / revise / skip) →
sleep 24h → measure outcomes → re-evaluate convergence. Resume-on-crash
via `goal_events(campaign_id, iteration, step_key)` idempotency.

`/goal grow LinkedIn impressions 30% in 14 days, $50 budget` in
`/admin/test-chat` is the smoke test.

### Knowledge Base

Single queryable surface: `kb_collections` → `kb_documents` → `kb_chunks`,
embedded into the existing `embeddings` table with `source_type='kb_chunk'`.
Admin UI at `/admin/knowledge`; visual references for the Art Director at
`/admin/knowledge/visual-references`. Sub-agents call `kb_search` /
`kb_read_document` / `kb_write_finding` / `kb_propose_update`.

### Learning loop

`agent_feedback` table captured on every approval decision. Insights
aggregated at `/admin/learning` (approval rate, edit-distance distribution,
top reasons, recent rejections). Synthesis workflow runs weekly (cron
`/api/cron/learning-synthesis`) — distils 3-7 themes into a
`learning-loop` KB playbook doc that the content sub-agent reads on its
next run via `findCommonMistakes` / `kb_search`.

### Cost & budget

`/admin/runs` lists every workflow run with rolled-up token + cost totals.
Goal-loop campaigns carry `budget_cents`; `assertWithinBudget` runs at the
top of every iteration and halts the loop with `loop_status='halted'` when
spend (computed from `llm_usage.cost_usd` joined through `workflow_runs`)
hits the cap.

### First-time bootstrap (post-cutover)

```bash
# 1. Apply migrations 0015-0020 in order
for m in 0015_knowledge_base 0016_goal_loop 0017_variants 0018_experiments 0019_lifecycle 0020_brand_visual_language; do
  DATABASE_URL=… pnpm --filter @marketing/db apply-sql packages/db/drizzle/${m}.sql
done

# 2. Seed the KB from the legacy markdown corpus
DATABASE_URL=… OPENAI_API_KEY=… pnpm --filter web exec tsx scripts/seed-kb.ts

# 3. Set env flags (in apps/web/.env.local)
GOAL_LOOP_LIVE=0     # keep goal-loop publishes in test mode while verifying
```

---

## First-launch checklist

The shortest path from a fresh clone to **`@marketing draft a blog post → human approves → it goes live at /blog/[slug]`**. Anything beyond the internal blog (LinkedIn, X, email, assets) is an additive opt-in per channel.

### 1. Tier-1 provisioning (≈ 30 min)

- [ ] **Supabase project**
  - Run `pnpm --filter @marketing/db migrate` against `DATABASE_URL` to apply migrations 0000 → 0003.
  - Apply [`infra/supabase/policies.sql`](infra/supabase/policies.sql) via the SQL editor.
  - Storage → create the `assets` bucket (private).
- [ ] **Upstash Redis** — create a database, copy the `rediss://…` URL.
- [ ] **Slack app** ([api.slack.com/apps](https://api.slack.com/apps))
  - Scopes: `app_mentions:read`, `chat:write`, `commands`, `users:read`, `views:open`.
  - Socket Mode on → generate `xapp-` App-Level Token (`connections:write`).
  - Install to workspace → grab `xoxb-` bot token.
- [ ] **API keys**
  - Anthropic console → API key (required to drive every sub-agent).
  - OpenAI platform → API key (required for the Phase 11 retrieval tools).
- [ ] **Internal token** — `openssl rand -hex 32`. Use the same value in every `.env`.

### 2. Wire `.env` files (≈ 10 min)

Copy [`.env.example`](.env.example) to `.env` and fill the **[BOOT]**, **[LLM]**, **[RAG]**, and **[CHAT] Slack** blocks. The other tiers can stay blank — adapters self-disable when their env vars are missing (see `apps/distributor/src/adapters/index.ts`).

```bash
cp .env.example .env
# fill in the [BOOT], [LLM], [RAG], [CHAT] Slack rows
```

There is one source of truth: the root `.env`. `apps/web/.env.local` and
`apps/manager/.env` are symlinks to it (Next.js follows symlinks; manager's
`--env-file=.env` follows it too). The distributor loads it explicitly via
`--env-file=../../.env` in its scripts.

### 3. Brand memory (≈ 1–2 hours of writing — this is content work, not code)

Without these the drafts will sound generic. They live in the `brand_memory`
table (added in migration `0004_brand_memory.sql` — apply via `pnpm
--filter @marketing/db migrate:0004` if you're upgrading an existing install)
and are edited from the admin UI at [`/admin/brand`](http://localhost:3000/brand).
Saves are live; the Manager picks up changes within ~5 minutes (in-process
TTL). Every save is captured in `audit_log`, so you get the same change
history you'd get from `git blame` on the old Markdown files.

After signing in at `/login`, open `/brand` and fill in:

- [ ] **Brand voice** (`brand.voice`) — tone, vocabulary, banned phrases.
- [ ] **Ideal customer profile** (`brand.icp`).
- [ ] **Product state** (`product.state`) — what the product actually is right now, and what it does NOT do.
- [ ] **Product positioning** (`product.positioning`) — the wedge / angle.
- [ ] (Phase 6.5 only) **Visual guidelines** (`brand.visual`).

The Markdown files in [`apps/manager/memory/brand/`](apps/manager/memory/brand/)
and [`apps/manager/memory/product/`](apps/manager/memory/product/) remain in
the repo as bootstrap templates. The Manager falls back to them only if the
`brand_memory` row is empty or the Control Plane is unreachable — they are
not the source of truth once the admin UI has been used.

### 4. Boot

```bash
pnpm install
pnpm --filter web dev          # http://localhost:3000
pnpm --filter manager dev      # connects to Slack via Socket Mode
pnpm --filter distributor dev  # listens on the publish + embed BullMQ queues
```

Sign in at `http://localhost:3000/login` (the email must match `AUTH_ALLOWLIST`).

### 5. Smoke test the loop

1. In Slack: `@marketing plan a campaign for <something>`. The Strategist should produce a brief.
2. `@marketing draft the launch blog post`. The Content sub-agent should call `find_brand_guidance` + `find_similar_content` + `find_common_mistakes`, then create a draft.
3. The Manager auto-posts an approval card to the originating thread on `submit_for_review`.
4. Click **Approve** in the Slack card (or in `/approvals` in the admin UI).
5. `@marketing publish the launch post to the blog`.
6. Visit `http://localhost:3000/blog/<slug>` — should be live within ~1 second of the `succeeded` PATCH.
7. Confirm the syndication card lands in the Slack thread.

### 6. Per-channel opt-ins (do these only when you're ready to publish there)

| Channel | What's needed | Time to set up |
|---|---|---|
| **LinkedIn** | Marketing API approval + `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_ORGANIZATION_URN` | 1–4 weeks (approval) |
| **X / Twitter** | Basic tier ($100/mo) + 4 OAuth 1.0a tokens | 1 day |
| **Email** | Pick HubSpot or Mailchimp; OAuth/API key + list ID | half-day |
| **Visual assets** | Pick Bannerbear or Placid; designer creates 2 templates; `REPLICATE_API_TOKEN` | 2–14 days |
| **GA4 metrics** | GCP service account + `GA4_PROPERTY_ID` | 1–2 hours |

### 7. Pre-launch hardening (Phase 10)

Once the loop works end-to-end, walk through the drills below: **Kill switch**, **Disaster drills**, **Credential rotation**, **Backup and restore**, **Load smoke test**, **Full campaign dry run**.

---

## Services map

| Service | Platform | URL / ref |
|---|---|---|
| Control Plane (Next.js) | Vercel | `apps/web` |
| Vercel Workflows (publish, embed, metrics, outcomes-rollup, weekly-analyst, single-post) | Vercel | `apps/web/workflows/*` — see [VERCEL-MIGRATION-PLAN](VERCEL-MIGRATION-PLAN.md) |
| Manager (OpenClaw bot) | Railway | `apps/manager` — deprecated; remove after dual-run completes |
| Distributor (BullMQ worker) | Railway | `apps/distributor` — deprecated; remove after dual-run completes |
| Database | Supabase Postgres | ref `ftpmzxkaiaxxcbnvqauy` |
| Redis | Upstash | see Doppler `REDIS_URL` |
| Secrets | Doppler | project `marketing-agent` |

> **Migration state (2026-05-04):** the platform is mid-cutover from a 3-app
> topology (web + manager + distributor) to a single Next.js + Vercel Workflow
> deploy. Phases 1–3 of [VERCEL-MIGRATION-PLAN.md](VERCEL-MIGRATION-PLAN.md)
> have shipped behind feature flags so the legacy and new paths run in
> parallel. Flip per-environment to switch:
>
> | Flag | When `1` |
> |---|---|
> | `WORKFLOW_PUBLISH` | `enqueuePublish(...)` runs `publishWorkflow` instead of pushing onto BullMQ |
> | `WORKFLOW_EMBED` | `enqueueEmbedding(...)` runs `embedContentWorkflow` instead of POSTing to the distributor |
> | `WORKFLOW_CHAT` | `/api/test-chat` runs the orchestrator in-process; `/api/test-chat/stream` is a Next.js `ReadableStream`; `/api/thread-notify` publishes web-thread events to the in-process bus instead of forwarding to manager |
>
> Drain BullMQ queues before flipping `WORKFLOW_PUBLISH` / `WORKFLOW_EMBED`.
> Manager + distributor processes can be powered off once each flag stays
> on for 24 h without regressions.

---

## Kill switch — pause all publishing

1. Admin UI → Settings → "Enable kill switch" button.
   - Or: `PATCH /api/settings` with `{ "kill_switch": true }` using internal token.
2. The Distributor worker checks the kill switch at the start of every job. In-flight jobs finish; no new jobs start.
3. To resume: same toggle → "click to disable".

---

## Disaster drill procedures

### Manager killed mid-conversation (thread state survives)

1. Verify `REDIS_URL` is set and Upstash is reachable.
2. Kill the Manager process (Railway: stop → start).
3. Send `@marketing hello` in any monitored channel.
4. Confirm the bot responds without losing thread context.
5. If context is lost: check `REDIS_URL` env var on Railway. The key format is `thread:slack:C{channelId}:T{ts}`.

### Distributor killed mid-job (BullMQ retries)

1. BullMQ persists job state in Redis. On restart, in-progress jobs re-enter the queue with `status = queued`.
2. Kill the Distributor (Railway: stop → start).
3. Verify the paused job resumes: check `publish_jobs` table — row should transition from `running` → `queued` → `running` → `succeeded`.
4. If a job is stuck in `running` after restart: manually `PATCH /api/publish-jobs/:id` with `{ "status": "failed", "error": "manual reset after restart" }` then re-enqueue.

### Workflow run failed mid-step (`WORKFLOW_PUBLISH=1` / `WORKFLOW_EMBED=1`)

1. Open the Workflow inspector — locally `pnpm --filter web exec workflow web`, or the Vercel dashboard's Workflows tab in production.
2. Find the failing run; each step shows its retry count and the last error.
3. Steps marked with `FatalError` (e.g. unknown channel, missing `OPENAI_API_KEY`) won't retry — fix the config, then start a new run rather than reusing the failed one.
4. Other failures auto-retry up to the SDK's default (3 attempts). If a run is wedged, cancel it from the inspector; the underlying DB row keeps the failure state from the gate / adapter step.
5. Cron-driven runs (`outcomes-rollup`, `metrics-fetch`, `weekly-analyst`) re-fire on schedule — no manual intervention needed unless the failure is structural.

### Next.js app down (Vercel auto-recover)

1. Vercel auto-redeploys from the last successful build within ~30 seconds.
2. No DB state is lost (Supabase is independent).
3. Verify: check Vercel deployment logs, then hit `/api/publish-jobs/today-count` to confirm the API is responding.

---

## Credential rotation

### Rotate all external tokens in Doppler
1. Go to Doppler → project `marketing-agent` → production config.
2. Rotate each token (LinkedIn, X, HubSpot/Mailchimp, Supabase service role, Upstash, Anthropic).
3. Doppler syncs to Railway env vars automatically (if the sync is enabled — verify under Integrations).
4. For Vercel: Doppler sync must be enabled for the `web` service. Verify under Vercel → Settings → Environment Variables.
5. **Verify adapters pick up new credentials without restart**: trigger a test publish to internal_blog after rotation and confirm it succeeds.

### Rotate Supabase service-role key
1. Supabase Dashboard → Settings → API → Roll service-role key.
2. Update `SUPABASE_SERVICE_ROLE_KEY` in Doppler.
3. Doppler → Railway + Vercel sync (see above).
4. Verify: hit `GET /api/campaigns` with the internal token — should return 200.

---

## Backup and restore

### Supabase PITR (Point-in-Time Recovery)
- Supabase Pro and above includes PITR. Verify it is enabled:
  - Dashboard → Settings → Database → Point-in-Time Recovery → confirm "Enabled".
- To restore: Dashboard → Settings → Database → Restore → select timestamp.
- Document last restore test date here: `___________`

### Daily pg_dump to Supabase Storage
- Script: `packages/db/scripts/pg-dump-backup.sh`
- Runs via Railway cron or GitHub Actions scheduled workflow.
- Output: `backups/YYYY-MM-DD.pgdump` in the `backups` Supabase Storage bucket.
- To restore from a dump:
  ```bash
  pg_restore --no-owner -d "$DATABASE_URL" backups/YYYY-MM-DD.pgdump
  ```

### Memory directories
- All `memory/` files are committed to git. The git remote is the backup.
- Run `git log --oneline -- apps/manager/memory/` to see the history of any memory file.

---

## Load smoke test (50 jobs in 5 minutes)

```bash
# From packages/db/scripts — create 50 approved content items and enqueue them.
node packages/db/scripts/load-smoke.mjs
```

Expected behaviour:
- Queue depth rises, then drains within ~2 minutes at concurrency 4.
- No duplicate publishes (verified by checking `publish_jobs` for duplicate `externalId`).
- Channel caps engage for channels with caps set (job status → `failed`, error contains "channel cap reached").
- Kill switch halts the queue if activated mid-run.

---

## Full campaign dry run (Phase 10 Day 5)

1. `@marketing plan a campaign for [product feature]` → Strategist produces brief.
2. `@marketing draft the launch post` → Content sub-agent creates draft.
3. Approve in admin UI → status becomes `approved`.
4. `@marketing publish the launch post to the blog` → Distributor enqueues.
5. Verify blog post live at `/blog/[slug]` within 30 seconds.
6. Verify syndication card posted to Slack thread.
7. (With LinkedIn/X creds): repeat for LinkedIn and X.
8. Wait for Monday cron or trigger `@marketing report on the campaign` manually.
9. Record full-cycle time here: `___________`

---

## Contacts

| Role | Name | Contact |
|---|---|---|
| Primary on-call | | |
| Supabase account | | |
| Doppler admin | | |
| Vercel owner | | |
| Railway owner | | |
