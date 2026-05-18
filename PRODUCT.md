# PRODUCT.md

> Source-of-truth spec for what this product **actually does today**.
> Written from the codebase, not aspirations. Every claim here is traceable
> to a file path. Use this as the input to naming, positioning, pricing,
> and brand-memory fills downstream.
>
> Status legend: **✅ Built** · **🚧 In progress / partial** · **📋 Planned**

---

## TL;DR

A multi-agent SaaS that runs the entire content-marketing loop for a small
team — strategy → drafts (text + image + video) → human approval →
publishing across 7 channels → analytics → automatic improvement next
cycle. One operator + this product replaces what a 3–5 person content
team would do, at roughly 1/10th the cost.

The product is **agentic**, not generative: it doesn't just spit out copy,
it plans campaigns, schedules them, judges its own work, learns from
what got approved vs. rejected, and uses past wins to ground the next
brief.

---

## The product, in one sentence

**An AI marketing team that ships campaigns end-to-end — strategy, copy,
images, video, scheduling, analytics — and gets sharper with every approval.**

---

## The job it does

Replaces (or augments) the **execution layer** of marketing:

| Old way | What this replaces |
|---|---|
| Strategist drafts a campaign brief in Notion | A Strategist agent generates a 4-week brief + calendar in <2 minutes, citing past wins. |
| Copywriter writes 12 posts across LinkedIn / X / blog / email | A Content agent drafts all 12 in parallel, in your brand's voice, with platform-native lengths. |
| Designer makes hero images and posters | An Asset pipeline (Art Director → image gen → vision-LLM judge) ships brand-consistent images at ~$0.07/post. |
| Social media manager schedules + posts | A Publish agent fires content to LinkedIn, X, Instagram, Facebook, HubSpot, Mailchimp, or internal blog with rate-limiting + retry. |
| Analyst pulls weekly reports in spreadsheets | An Analyst agent rolls outcomes nightly (CTR, engagement, conversions) and surfaces top performers. |
| Team holds weekly retros to discuss what worked | A Learning-Synthesis workflow ingests every approval/rejection + outcomes weekly and writes new playbook lessons that the Content agent reads on its next run. |

What it does **NOT** replace: the human who knows the business, sets the
real strategy, and signs off on every published piece. This product is
the execution + memory layer underneath that human.

---

## How it works — agentic architecture

A **multi-agent pipeline** where each agent has narrow scope, its own
tools, and reads/writes structured brand context. Every agent's output is
auditable in the admin UI.

```
Researcher ─┐
            ↓
Strategist → Content → Art Director → Asset Gen → Asset Judge ──┐
                                                                ↓
                                                         Approval (human)
                                                                ↓
                                                            Publisher
                                                                ↓
                                                             Analyst
                                                                ↓
                                                         Learning Loop
                                                                ↓
                                                       (back to Strategist)
```

### The nine sub-agents ✅ Built

All in [`packages/agents/src/sub-agents/`](packages/agents/src/sub-agents/):

| Agent | What it does | Key tools |
|---|---|---|
| **Strategist** ([strategist.ts](packages/agents/src/sub-agents/strategist.ts)) | Builds campaign briefs + content calendars. Picks phase (buildup/launch/post-launch) × stage (pull/explain/reinforce/push) mix. Sets the campaign's visual identity (motifs, color mood, art style, banned aesthetics). Cites past wins. | `create_campaign`, `write_calendar`, `set_visual_identity`, `find_similar_content`, `read_past_learnings` |
| **Content** ([content.ts](packages/agents/src/sub-agents/content.ts)) | Drafts a single post in the right voice for the right channel, plus an image brief. Reads brand voice + ICP + past wins + common-mistake list before writing. | `submit_for_review`, `find_brand_guidance`, `find_common_mistakes` |
| **Art Director** ([art-director.ts](packages/agents/src/sub-agents/art-director.ts)) | Refines the Content agent's image brief into a `VisualConceptBrief` using campaign visual identity + visual references KB. Deterministic post-migration 0029. | reads design-system + visual-references |
| **Asset** ([asset.ts](packages/agents/src/sub-agents/asset.ts)) | Generates images (Gemini Nano or Replicate models) and videos. Uploads to Supabase storage. ~$0.07/post after the judge-retry pipeline. | `image_gen`, `video_gen`, `render_template`, `upload_asset` |
| **Asset Judge** ([asset-judge.ts](packages/agents/src/asset-judge.ts)) | Vision-LLM scorer. Rates each generated image on 5 axes (subject specificity, brand fit, composition, originality, on-message). Rejects → retries once before accepting. | vision LLM |
| **Researcher** ([researcher.ts](packages/agents/src/sub-agents/researcher.ts)) | Audience / persona / competitor research. Fetches web pages, looks up X profiles, writes findings to the KB. Cron-triggered daily. | `web_fetch`, `kb_search`, `kb_write_finding`, `x_read_profile`, `kb_archive_image` |
| **Analyst** ([analyst.ts](packages/agents/src/sub-agents/analyst.ts)) | Weekly performance synthesis. Pulls publish-job outcomes + GA4 metrics, writes summary. Drives the Insights dashboard. | `query_campaign_performance` |
| **SEO** ([seo.ts](packages/agents/src/sub-agents/seo.ts)) | Keyword research (Serper.dev) + on-page metadata writeback to `content_items.seo_meta`. | `keyword_research`, `write_seo_meta` |
| **Lifecycle** ([lifecycle.ts](packages/agents/src/sub-agents/lifecycle.ts)) 🚧 | Multi-step email sequence design. Inserts `lifecycle_sequences` + `lifecycle_steps`. End-to-end flow still being wired. | `create_sequence`, `list_sequences` |
| **Experiment** ([experiment.ts](packages/agents/src/sub-agents/experiment.ts)) 🚧 | A/B variant registration + Bayesian winner selection (beta-binomial on CTR). Registry live; UI dashboard not yet wired. | `register_experiment`, `propose_winner` |

### Eleven workflows ✅ Built

All in [`apps/web/workflows/`](apps/web/workflows/):

| Workflow | What it runs | Trigger |
|---|---|---|
| [single-post](apps/web/workflows/single-post.ts) | Draft → asset pipeline → submit → wait for approval → publish | User clicks "Create" or schedule |
| [campaign-plan](apps/web/workflows/campaign-plan.ts) | Strategist generates a multi-week calendar in one shot | User starts a campaign |
| [asset-pipeline](apps/web/workflows/asset-pipeline.ts) | Art Direction → translate-prompt → generate → judge → retry-or-accept → upload | Inside single-post |
| [publish](apps/web/workflows/publish.ts) | Kill-switch check → channel-cap check → adapter dispatch → mark succeeded | After approval |
| [goal-loop](apps/web/workflows/goal-loop.ts) 🚧 | Plan → fanout content → wait approvals → publish → sleep 24h → measure → re-evaluate convergence | User creates a goal |
| [learning-synthesis](apps/web/workflows/learning-synthesis.ts) | Aggregate feedback last N days → LLM distils 3–7 lessons → upsert KB playbook doc | Weekly cron |
| [weekly-analyst](apps/web/workflows/weekly-analyst.ts) | Runs Analyst agent, emits performance summary | Weekly cron |
| [outcomes-rollup](apps/web/workflows/outcomes-rollup.ts) | Pre-rolls 7d/30d/90d performance from publish-jobs + GA4 | Nightly cron |
| [metrics](apps/web/workflows/metrics.ts) | GA4 session/conversion fetch | Cron |
| [research](apps/web/workflows/research.ts) | Researcher sub-agent run | Cron |
| [kb-ingest](apps/web/workflows/kb-ingest.ts), [embed](apps/web/workflows/embed.ts) | Chunk + embed uploaded docs into pgvector | On upload |
| [asset-promotion](apps/web/workflows/asset-promotion.ts) | Top-performing assets surfaced in gallery | Cron |

Workflows run durably on Vercel Workflows; engine-agnostic infrastructure (custom / vercel / cloudflare) so the same step graph can run anywhere.

---

## What you can do with it — by user journey

### Day 1: Onboard a new workspace ✅

[/onboarding/wizard.tsx](apps/web/app/onboarding/wizard.tsx) walks a new admin through:

1. **Welcome** — workspace name, one-line pitch.
2. **Upload source documents** — PDF / DOCX / MD describing the company, products, voice. Up to 25 MB each.
3. **AI extraction** — a brand-extract agent reads the docs and drafts the six brand-memory cards + the design tokens.
4. **Review + accept** — edit drafts inline, save to the workspace.

After this the agents have everything they need to write on-brand from
the first run.

### Day 2: Set up brand intelligence ✅

[/brand](apps/web/app/(admin)/brand/page.tsx) — Three structured artifacts the agents read on **every run**:

**1. Brand memory** — 6 free-form markdown slugs:
- `brand.voice` — tone, vocabulary, banned phrases
- `brand.icp` — ideal customer profile
- `brand.visual` — palette, typography, aspect ratios, banned looks
- `product.state` — what's built / what's NOT yet (prevents drafts that claim missing features)
- `product.positioning` — category, promise, proof points, against-frame
- `market.context` — pricing story, cultural notes, festival calendar, competitor framing

**2. Market context (structured)** — typed fields:
- `primary_country` (ISO 3166-1 alpha-2)
- `target_regions[]` (countries or labels like "South Asia")
- `languages[]` (BCP-47 tags)
- `primary_channels[]` (channels to prioritize)

Strategist injects both into its system prompt so content stops being geo-generic.

**3. Design system** — structured JSON:
- Colors (palette with semantic tokens)
- Typography (font stacks, weights)
- Logos (uploaded with signed-URL serving)
- Tokens (custom design tokens)

Asset agent reads these verbatim — hex values stay exact.

### Day 3: Run your first campaign ✅

[/campaigns](apps/web/app/(admin)/campaigns/page.tsx) → **New campaign**:

1. Topic → Strategist runs (8 reasoning steps max). Pulls `find_similar_content` for past wins, reads all 6 brand-memory slugs, generates a campaign brief + content calendar with phase × stage mix:
   - **Buildup phase**: 40% pull / 40% explain / 20% reinforce / 0% push
   - **Launch phase**: 20% pull / 20% explain / 20% reinforce / 40% push
   - **Post-launch**: 10% pull / 30% explain / 40% reinforce / 20% push
2. Sets `visual_identity` for the campaign — recurring motifs, color/mood, art style, banned aesthetics. Every image in the campaign is art-directed against this.
3. You review the brief, edit, approve.

### Day 4: Generate content ✅

Each calendar item triggers a `single-post` workflow:
- Content agent drafts the post + image brief.
- Art Director composes a visual concept brief from the image brief + campaign visual identity + visual-references KB.
- Asset pipeline generates 1 image, judges it, retries once if rejected.
- Submitted for approval.

Cost per post: ~$0.07 (image gen) + LLM tokens. Tracked per workspace.

### Day 5: Approve + publish ✅

[/approvals](apps/web/app/(admin)/approvals/page.tsx) — Pending items with:
- Side-by-side: AI draft vs. your edits (edit distance shown).
- Decision panel: approve / request changes / reject (with reason).
- Bulk approve.
- Stuck-workflow warnings (workflows that crashed mid-run).

Approved → `publishWorkflow` fires:
- Kill-switch check (`settings.kill_switch` JSON in `settings` table)
- Channel cap check (`channel_caps` — e.g. max 5 LinkedIn posts/day)
- Adapter dispatches to the channel
- Marks succeeded, captures external URL, notifies the Slack/Discord thread

### Day 7+: Observe + learn ✅

- **[/insights](apps/web/app/(admin)/insights/page.tsx)** — Top performers by CTR / engagement / impressions / clicks. 7d / 30d / 90d windows. Per-channel breakdown.
- **[/learning](apps/web/app/(admin)/learning/page.tsx)** — Rejection-reason aggregation, common-mistake embeddings, synthesized playbook lessons.
- **[/runs](apps/web/app/(admin)/runs/page.tsx)** — Every workflow run, with LLM token cost rollups for superadmins.
- **[/audit-log](apps/web/app/(admin)/audit-log/page.tsx)** — Every action (human / agent / system) on every entity.

Weekly `learning-synthesis` workflow: distills the last week's feedback into 3–7 lessons, upserts them into the KB. Content agent reads them on its next draft via `find_common_mistakes`. **The loop closes.**

---

## Channels — what it publishes to

[CHANNELS enum](packages/shared-types/src/index.ts#L125-L134), adapters in [packages/agents/src/adapters/](packages/agents/src/adapters/):

| Channel | What gets posted | Auth required | Status |
|---|---|---|---|
| **Internal blog** | Long-form articles with slug routing | None (writes to `content_items.status = published`) | ✅ |
| **LinkedIn** | Articles + posts | `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_ORGANIZATION_URN` | ✅ |
| **X / Twitter** | Single posts + threads, with media | `X_ACCESS_TOKEN` (OAuth1) | ✅ |
| **Instagram** | Posts + reels + carousels | `META_PAGE_ACCESS_TOKEN` + `IG_BUSINESS_ACCOUNT_ID` | ✅ |
| **Facebook** | Posts | `META_PAGE_ACCESS_TOKEN` + `FB_PAGE_ID` | ✅ |
| **Email — HubSpot** | Email campaigns to a HubSpot list | `HUBSPOT_ACCESS_TOKEN` | ✅ |
| **Email — Mailchimp** | Email campaigns to a Mailchimp list | `MAILCHIMP_API_KEY` | ✅ |

Each adapter implements: `publish(content)`, `retract(id)`, returns external URL on success.

Status managed in `publish_jobs` table: queued → running → succeeded / failed / cancelled. Retries with attempt count. Scheduled publishing supported (any future timestamp).

---

## Knowledge base — agents have memory

[`packages/agents/src/kb/`](packages/agents/src/kb/)

A pgvector-backed semantic search index over everything the agents produce or consume:

- **Collections** (enum): `brand`, `product`, `persona`, `competitor`, `sop`, `playbook`, `past_content`
- **Documents** have versions, status (active / archived), source (uploaded / generated / inferred)
- **Chunks** are markdown-chunked, embedded with OpenAI `text-embedding-3-small` (1536d)
- **Retrieval** — semantic ANN + optional Cohere reranking
- **Multi-tenant isolation** — every embedding tagged with `workspace_id`

What gets indexed:
- Uploaded brand documents (PDF/DOCX/MD)
- Past approved content (`past_content` collection — fed to `find_similar_content`)
- Rejected drafts (for `find_common_mistakes`)
- Researcher findings
- Visual references (image gallery → Art Director)
- Synthesized playbook lessons

UI:
- [/knowledge](apps/web/app/(admin)/knowledge/page.tsx) — browse, search, manage
- [/knowledge/visual-references](apps/web/app/(admin)/knowledge/visual-references/page.tsx) — image gallery the Art Director draws from

---

## The learning loop — what makes it agentic, not generative

Three feedback signals get captured and fed back into future drafts:

**1. Approval decisions** — every approve/reject/change-request logged with reason, edit distance (Levenshtein between AI draft and human-final), and decided-by. Table: `agent_feedback`.

**2. Outcomes** — publish-job CTR, engagement, impressions, conversions; rolled up nightly into `outcomes` table per content × channel × window (7d/30d/90d).

**3. Synthesized lessons** — weekly cron aggregates the above, asks an LLM to distill 3–7 actionable lessons, writes them to the KB playbook collection.

**On the next draft**: Content agent calls `find_common_mistakes` and `find_similar_content` *before* writing. The lessons land inside the system prompt. The Strategist does the same with `read_past_learnings`.

So: a rejected draft on Tuesday becomes a guardrail on Wednesday. A post that hit 4× the average CTR on LinkedIn becomes a cited example in the next brief targeting that channel.

---

## Multi-tenant SaaS — built in from migration 0024 onward

Schema lives in [`packages/db/src/schema.ts`](packages/db/src/schema.ts). Tables:

- `workspaces` — one row per tenant (name, slug, owner, plan)
- `workspace_members` — role-based access (owner / admin / member), invite tokens
- `admin_users` — cross-tenant superadmin role
- `plans` — plan definitions (code, features[], quotas{}, price_cents)
- `subscriptions` — billing state per workspace (status, period, provider: stripe/khalti/manual)
- `usage` — monthly metering (content_drafts, llm_tokens_used, etc.)

Every core table has `workspace_id` and uses Row-Level Security policies.

**Superadmin governance** at [/super/*](apps/web/app/super/) — workspaces, users, subscriptions, usage, models (per-user allow-list), invites.

**Billing providers wired**:
- Stripe (international) — schema-ready
- Khalti (Nepal-region) — schema-ready  
- Manual (enterprise / free-friend tenants — plan override until a date)

🚧 **Webhook integration status**: provider IDs and statuses are stored; the webhook handlers that flip subscription states are partial.

---

## Observability

What you can see, live:

| Page | Shows |
|---|---|
| [/creation-workflow](apps/web/app/(admin)/creation-workflow/page.tsx) | Active workflow runs with per-step pipeline (researcher → strategist → content → asset → analyst → publisher) |
| [/runs](apps/web/app/(admin)/runs/page.tsx) | Run history with LLM cost rollups (superadmin sees cost; everyone sees status) |
| [/publish-jobs](apps/web/app/(admin)/publish-jobs/page.tsx) | Channel publish queue with retries + external URLs |
| [/insights](apps/web/app/(admin)/insights/page.tsx) | Top performers (sortable by metric, windowed by 7/30/90d, per-channel) |
| [/gallery](apps/web/app/(admin)/gallery/page.tsx) | Every generated asset with status, kind, signed preview |
| [/audit-log](apps/web/app/(admin)/audit-log/page.tsx) | Every action, every actor (superadmin-restricted) |
| [/learning](apps/web/app/(admin)/learning/page.tsx) | Common mistakes + synthesized playbook lessons |

LLM cost per run, per agent, per workspace — all metered into `llm_usage`.

---

## Integrations

[/integrations](apps/web/app/(admin)/integrations/page.tsx) — OAuth/key status + setup instructions for:

- **Publishing**: LinkedIn, X, Instagram, Facebook, HubSpot, Mailchimp
- **Notifications**: Slack (approval cards + weekly reports), Discord (parallel)
- **Analytics**: GA4 (session + conversion metrics)
- **Research**: Serper.dev (Google keyword data), X profile lookup

All env-var-keyed; absence falls back gracefully (e.g. Serper missing → stub keyword response).

---

## Playground / Test chat

[/test-chat](apps/web/app/(admin)/test-chat/page.tsx) — Interactive agent testing with slash commands:

- `/campaign_plan <topic>` — Run Strategist on a hypothetical campaign
- `/single_post <topic> <channel>` — Run Content + Asset on a one-off post
- `/research <topic>` — Run Researcher
- `/analyst` — Run Analyst on current data
- `/seo <contentId>` — Run SEO agent on existing content

Model selector — switch between Claude / GPT / Gemini / local provider per chat.

---

## API surface

[~62 routes under `apps/web/app/api/`](apps/web/app/api/) — all workspace-scoped, all auth-gated. Major groups:

- **Content & campaigns**: CRUD on campaigns, content_items, approvals, publish_jobs
- **Brand intelligence**: brand-memory, brand-design-system, brand-documents, workspace/market-context
- **Workflows**: trigger single-post, campaign-plan; approval hook; resume-on-decision
- **Assets**: list, select, signed-URL refresh
- **Observability**: workflow_runs, insights, audit-log, usage
- **Cron-only** (gated by `INTERNAL_API_TOKEN`): research, learning-synthesis, outcomes-rollup, metrics-fetch, weekly-analyst, asset-promotion
- **Superadmin** (gated by `admin_users`): super/* governance routes

---

## What it doesn't do yet — honest list

🚧 **Goal loop UI** — the workflow is built; the admin-side trigger (create a goal, watch it run for N weeks) isn't fully wired.

🚧 **Experiments dashboard** — A/B registry exists; the "see which variant won" UI is a stub.

🚧 **Video generation** — the `video-gen.ts` module is scaffolded; production provider integration (Veo / Runway) is partial.

🚧 **Lifecycle automation end-to-end** — sequences are designed by the Lifecycle agent; orchestrator chaining publish_jobs across sequence steps isn't fully wired.

🚧 **Billing webhooks** — Stripe / Khalti webhook handlers that flip subscription state are stubs.

📋 **Self-serve sign-up + onboarding for strangers** — onboarding wizard works for invited users; public sign-up flow needs review.

📋 **Public landing page** — none exists in-repo; would need a marketing site for self-serve.

📋 **Sandbox / demo workspace** — no built-in "try without signing up" mode.

📋 **Slack/Discord weekly digest** — approval cards work; rolling weekly summary post is not yet wired.

📋 **Detailed win-loss analysis** — agent_feedback captures rejection reasons but no dedicated dashboard mines them for patterns beyond `find_common_mistakes`.

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 15 App Router (with the repo's own non-stock conventions) + React Server Components + Tailwind |
| Backend | Next.js Route Handlers + Vercel Workflows |
| Database | Postgres (Supabase) with pgvector for embeddings |
| ORM | Drizzle |
| Auth | Supabase Auth (email + magic link + password) |
| Storage | Supabase Storage (`assets` bucket, signed URLs) |
| LLMs | Claude (Anthropic), GPT-4 / GPT-5 (OpenAI), Gemini (Google) — model selectable per agent |
| Image gen | Gemini Nano, Replicate models |
| Vision judge | Claude vision / GPT vision |
| Embeddings | OpenAI `text-embedding-3-small` (1536d) |
| Reranking | Cohere (optional) |
| Search | Serper.dev (Google SERPs) |
| Analytics | GA4 |
| Workflow engine | Vercel Workflows (with engine-agnostic abstraction) |
| Billing | Stripe (international) + Khalti (Nepal) — schema-ready |
| Monorepo | pnpm + TurboRepo |

---

## Differentiators — what the product positioning should lean on

Reading the codebase, the actual differentiators (vs. Jasper / Copy.ai / Lavender / Writer / Buffer / etc.):

1. **Agentic, not generative.** Not a "write me a tweet" box. Plans campaigns, schedules them, judges its own assets, learns from approvals. The pipeline replaces a team, not a chair.
2. **Brand intelligence is structured, not vibes.** Six brand-memory slugs + design system + market context + KB are *all* read on every run. The agent doesn't drift.
3. **Closed learning loop.** Approval decisions + outcomes + synthesized lessons feed back into the next draft. Most tools are stateless; this isn't.
4. **Cost-engineered.** Asset pipeline is ~$0.07/post (judge-and-retry pattern, single image gen). LLM tokens metered per workspace. Built for unit economics, not demos.
5. **Multi-tenant from day one.** Workspace isolation via RLS, role-based access, billing/quotas. Not a single-tenant prototype patched for SaaS.
6. **Channels-native.** Posts go where they belong: X threads as threads, LinkedIn as articles, IG as reels, HubSpot/Mailchimp as email campaigns — not "export and copy-paste."
7. **Observable end-to-end.** Every step of every run is auditable. Every action is logged. Cost-per-run is visible.
8. **Built on real workflow infra.** Durable execution (resumable across crashes), not a script that dies on a network blip.

---

## Open questions (decisions still to make)

- **Pricing** — freemium tiers, sales-led pilot, or agency licence? Not coded yet.
- **Self-serve sign-up flow** — invited-users-only works; strangers' flow needs review.
- **Public landing page** — out of scope of the app; needs separate marketing site.
- **ICP focus for marketing** — who do we sell to first (solo founders / scale-ups / agencies / Nepal SMBs)?
- **Pricing currency / geo lead** — global from day one or Nepal-first?
- **Brand name** — to be picked once positioning is locked.

---

## Suggested reading order if you're new to the code

1. [packages/agents/src/sub-agents/strategist.ts](packages/agents/src/sub-agents/strategist.ts) — see the simplest agent end-to-end
2. [apps/web/workflows/single-post.ts](apps/web/workflows/single-post.ts) — the main user-facing workflow
3. [packages/db/src/schema.ts](packages/db/src/schema.ts) — every table, every enum, every relationship
4. [apps/web/app/(admin)/brand/page.tsx](apps/web/app/(admin)/brand/page.tsx) — the most-edited admin page
5. [packages/agents/src/memory.ts](packages/agents/src/memory.ts) + [brand-store.ts](packages/agents/src/brand-store.ts) — how brand context is injected into every agent

---

*Last updated: 2026-05-16. Update when sub-agents / workflows / channels change.*
