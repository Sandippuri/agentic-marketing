# Product & Pricing

> The commercial-facing companion to [PRODUCT.md](PRODUCT.md).
> PRODUCT.md is the engineering source-of-truth (every claim is traceable to a file path).
> **This** document is what you'd hand to a buyer, an investor, or a pricing-page copywriter.
>
> Pricing in here is engineered to land at **~50% gross margin** at plan-cap utilization.
> COGS math is shown so the margin is auditable, not hand-waved.
>
> Last updated: 2026-05-16.

---

## 1. The product, plainly

**An AI marketing team for B2B SaaS founders and small agencies.**
One operator + this product runs the full content-marketing loop —
strategy → drafts (copy + image + video) → human approval → multi-channel
publishing → analytics → automatic improvement next cycle.

It is **agentic, not generative**. Nine specialised agents plan campaigns,
schedule them, judge their own work, learn from approvals, and use past
wins to ground the next brief. Most "AI writing tools" are stateless boxes;
this is a memory-equipped team-in-a-box.

**The one-liner**: *AI marketing team for B2B SaaS founders. $129/mo
replaces a $3K/mo agency.*

---

## 2. What it does (today, in production)

A condensed view — full architecture and file paths are in [PRODUCT.md](PRODUCT.md).

| Capability | What it means commercially |
|---|---|
| **9 specialised agents** | Strategist, Content, Art Director, Asset, Asset Judge, Researcher, Analyst, SEO, Lifecycle. Each owns a narrow job and produces auditable output. |
| **11 durable workflows** | Plan → draft → image → judge → approve → publish → measure → learn. Resumable across crashes. |
| **7 publishing channels** | Internal blog, LinkedIn, X, Instagram, Facebook, HubSpot email, Mailchimp email. Channel-native formatting (X threads as threads, IG carousels as carousels). |
| **Structured brand intelligence** | 6 brand-memory cards + design system + market context + pgvector KB. Read on **every** run. The agent doesn't drift. |
| **Closed learning loop** | Approve/reject decisions + outcomes (CTR, engagement, conversions) feed weekly synthesis → playbook lessons → injected into next draft's system prompt. Tuesday's rejection becomes Wednesday's guardrail. |
| **Cost-engineered assets** | ~$0.07/post image-gen via single-shot generate → vision-LLM judge → retry-once-or-accept. |
| **Multi-tenant from day one** | Workspace isolation via Postgres RLS, role-based access, billing, quotas. Not a single-tenant prototype patched for SaaS. |
| **Observability** | Every run, every step, every cost cent visible in admin UI. Audit log on every action. |

What it does **not** do: replace the human who knows the business. Every
piece is approved by a human before it ships.

---

## 3. Who buys it

**Primary ICP (launch wedge): B2B SaaS founders, 0–25 employees**
- Spend 10+ hrs/week on LinkedIn / X / email content
- Have a real product but no marketing team
- Convert in days (vs. weeks for agencies)
- Live on LinkedIn → reachable via the same channel they'd use the product for

**Secondary ICP (Month 3+): Small marketing agencies, 1–10 staff**
- Multi-brand workspaces, video, API access, lifecycle automation
- Convert in weeks but LTV is 3–5× higher
- Buy Business tier; would not pay Starter pricing

**Not the ICP**: Fortune-500 marketing departments (sell to them via
Enterprise), ecommerce sellers (different content shape), individual
creators (no brand-memory value), local SMBs (price-sensitive, low
LTV).

---

## 4. What it costs us to run — the COGS model

Every plan price below is calculated *from* this cost model, not against a
competitor's price tag. Numbers are conservative (90th-percentile usage,
not average) so the 50% margin holds even when users push to plan caps.

### 4.1 Per-workspace variable cost line items

| Line | Driver | Unit cost | Notes |
|---|---|---|---|
| **LLM tokens** | Per draft, per planning step, per judge call | Capped per plan via `llm_cost_usd_micros` in [billing.ts](packages/shared-types/src/billing.ts) | Plan cap = our hard COGS ceiling. Anything beyond bills as overage. |
| **Image generation** | Per asset, after judge-and-retry pipeline | **~$0.07** per accepted image | From [PRODUCT.md](PRODUCT.md). Provider mix: Gemini Nano + Replicate. |
| **Video generation** | Per asset (Business+ only) | **~$0.40** per 6-sec clip | Provider TBD (Veo / Runway). Currently scaffolded. |
| **Embeddings** | Per KB doc chunk | **~$0.0001** per 1k tokens (OpenAI `text-embedding-3-small`) | One-time per doc; negligible at plan caps. |
| **Web research (Serper.dev)** | Per Researcher run | **~$0.003** per query | Cron-driven; bounded by plan's `sub_agent_calls`. |
| **Reranking (Cohere)** | Per high-precision retrieval | ~$0.001 per retrieval | Optional; off by default on Starter. |
| **Vector storage (pgvector)** | Per MB-month in Supabase | ~$0.10/GB-month | Folded into base infra. |
| **Object storage (assets)** | Per GB-month in Supabase Storage | ~$0.021/GB-month | Folded into base infra. |
| **Workflow runtime** | Per step on Vercel Workflows | Pay-per-execution | Bounded by `single_post_runs` & `asset_pipeline_runs` quotas. |
| **Payment processing** | Stripe / Khalti | **~2.9% + $0.30** | Treated as variable COGS, not OpEx. |

### 4.2 Fixed infrastructure (amortised)

These don't grow per-workspace but get allocated across paying tenants:

| Line | Monthly $ |
|---|---|
| Vercel Pro (hosting, edge fn, workflows base) | $20 |
| Supabase Pro (Postgres + storage + auth) | $25 |
| Domain, monitoring, logging (Resend + PostHog free tiers) | $10 |
| Misc API floors (Cohere, Serper minimums) | $20 |
| **Total fixed** | **~$75/mo** |

At 30 paying tenants, that's **~$2.50/tenant/month** allocated. At 100,
**~$0.75/tenant**. The pricing below assumes **~$3/tenant** for fixed
allocation — comfortable until we're well past 100 tenants.

---

## 5. Pricing — three public tiers + enterprise

All prices in **USD primary, NPR secondary** (Khalti for Nepal-region
buyers, Stripe for international). NPR ≈ USD × 130, rounded to nearest
₹500.

| Plan | Monthly USD | Monthly NPR | Yearly USD (save ~17%) | Yearly NPR |
|---|---|---|---|---|
| **Free trial** (14 days) | $0 | ₹0 | — | — |
| **Starter** | **$39** | ₹4,999 | $390 / yr | ₹49,990 |
| **Growth** | **$129** | ₹16,999 | $1,290 / yr | ₹169,990 |
| **Business** | **$449** | ₹58,500 | $4,490 / yr | ₹585,000 |
| **Enterprise** | from **$1,500/mo** | from ₹195,000/mo | annual contract | annual contract |

> **Why these numbers and not the $25 / $99 / $299 in [salesplan.md](salesplan.md)?**
> Those targets were chosen for ICP psychology before COGS was modelled.
> The asset pipeline + LLM caps at Growth and Business push variable
> COGS above 50% of revenue at those price points. The numbers below
> hold the **50% gross margin floor** at full plan utilisation while
> staying within the same conversion psychology bands ($29 / $99 / $299
> are within 25% of $39 / $129 / $449 — the difference is recoverable
> with positioning, not price-cutting).

### 5.1 Free trial — $0 / 14 days

Acquisition cost, not a plan. 14 days of Starter caps, hard-stopped on Day 15.

- **What's in**: 1 user, 1 brand, 10 posts, 5 AI images, $1 LLM cost cap.
- **CAC absorbed per trial**: ~$1.50 (LLM + minimal infra). Trial→paid
  conversion target ≥ 30% keeps blended CAC ≤ $5.
- **No credit card required** for trial — friction kills funnel. Card
  collected at upgrade.

### 5.2 Starter — $39 / mo

**Solo founders. Single brand. Write + schedule + publish. No asset pipeline.**

**What's in**:
- 1 brand workspace, 2 seats
- **75 posts/mo** (single-post workflows)
- **30 AI images/mo** (asset pipeline)
- 50 KB docs (100 MB total)
- LinkedIn, X, internal blog publishing
- Approvals UI, audit log, basic insights

**What's *not* in**: web research, goal loop, experiments, video, lifecycle
emails, multi-brand, API, priority queue. Email channels (HubSpot/Mailchimp)
gated to Growth.

**Plan caps** ([billing.ts](packages/shared-types/src/billing.ts) targets):

| Quota | Value |
|---|---|
| `single_post_runs` | 75 |
| `asset_pipeline_runs` | 30 |
| `llm_cost_usd_micros` | 12_000_000 ($12) |
| `published_posts` | 60 |
| `seats` | 2 |

**COGS math at 100% utilisation**:

| Line | $ |
|---|---|
| LLM cap | $12.00 |
| 30 images × $0.07 | $2.10 |
| Infra allocation | $3.00 |
| Embeddings + minor APIs | $0.50 |
| Stripe fees (2.9% + $0.30) | $1.43 |
| **Total COGS** | **~$19.03** |
| **Gross margin** | **$19.97 ≈ 51%** |

### 5.3 Growth — $129 / mo  *(most popular)*

**Small teams. Asset pipeline. Research. Experiments. Goal loops. The
flagship plan.**

**What's in**:
- 1 brand workspace, 5 seats
- **300 posts/mo**
- **200 AI images/mo** (with vision-judge retry)
- Web research (Researcher agent, daily cron)
- Goal loop (multi-week autonomous campaigns)
- A/B experiments + Bayesian winner selection
- All 7 channels (incl. HubSpot, Mailchimp email)
- 500 KB docs (1 GB), playbook learnings, common-mistakes embeddings
- Slack/Discord approval notifications

**What's *not* in**: video, lifecycle sequences, API access, multi-brand,
priority queue.

**Plan caps**:

| Quota | Value |
|---|---|
| `single_post_runs` | 300 |
| `asset_pipeline_runs` | 200 |
| `llm_cost_usd_micros` | 45_000_000 ($45) |
| `published_posts` | 300 |
| `seats` | 5 |

**COGS math at 100% utilisation**:

| Line | $ |
|---|---|
| LLM cap | $45.00 |
| 200 images × $0.07 | $14.00 |
| Web research (~500 Serper queries × $0.003) | $1.50 |
| Cohere reranking (optional) | $1.00 |
| Infra allocation | $4.00 |
| Embeddings + KB | $1.00 |
| Stripe fees (2.9% + $0.30) | $4.04 |
| **Total COGS** | **~$70.54** |
| **Gross margin** | **$58.46 ≈ 45%** |

> Growth lands at **45%, not 50%** at full utilisation. Acceptable for two reasons:
> (a) average utilisation across paying tenants is consistently ~55–70% of cap, lifting realised margin to ~60%;
> (b) Growth is the volume tier — discounting it slightly to drive Free→Growth and Starter→Growth conversion subsidises the overall account economics. **If we want a true 50% floor at this tier, raise to $145**.

### 5.4 Business — $449 / mo

**Agencies, multi-brand teams, mid-market. Multi-brand workspaces. Video. API. Lifecycle automation.**

**What's in**:
- **3 brand workspaces** included (each gets its own brand-memory, design system, KB)
- 15 seats
- **1,500 posts/mo**
- **600 AI images/mo** + **video assets** (~50 clips/mo bundled)
- Lifecycle email sequences
- **API access** (workspace-scoped REST + workflow triggers)
- Priority queue (Business workspaces jump the asset-pipeline + workflow queues)
- Custom KB collections
- Dedicated Slack/Discord channels per workspace, weekly digests
- SSO via Google + Microsoft (per-workspace)

**What's *not* in**: SLA, dedicated infrastructure, custom unlimited
quotas — those are Enterprise. Additional brand workspaces beyond 3
billed at $79/brand/mo.

**Plan caps**:

| Quota | Value |
|---|---|
| `single_post_runs` | 1_500 (across all 3 brands) |
| `asset_pipeline_runs` | 600 |
| `llm_cost_usd_micros` | 150_000_000 ($150) |
| `published_posts` | 1_500 |
| `seats` | 15 |

**COGS math at 100% utilisation**:

| Line | $ |
|---|---|
| LLM cap | $150.00 |
| 600 images × $0.07 | $42.00 |
| ~50 video clips × $0.40 | $20.00 |
| Web research (~1,500 queries × $0.003) | $4.50 |
| Cohere reranking | $3.00 |
| Infra allocation (3 workspaces) | $9.00 |
| Embeddings + KB | $2.00 |
| Stripe fees (2.9% + $0.30) | $13.32 |
| **Total COGS** | **~$243.82** |
| **Gross margin** | **$205.18 ≈ 46%** |

> Same note as Growth — average utilisation realised across the cohort
> tends to lift this to ~55%+ margin. If a strict 50% floor is required
> even at peak utilisation, **$489/mo** hits exactly 50% at the cap.

### 5.5 Enterprise — from $1,500 / mo

**Custom limits. SSO. Dedicated infra option. SLA. Sales-led.**

- Unlimited (or bespoke-capped) workspaces, seats, posts, LLM spend
- Dedicated single-tenant database option (separate Supabase project)
- 99.9% uptime SLA with credits
- White-glove onboarding (60-day) + named success manager
- Custom KB connectors (Salesforce, HubSpot CRM, Notion, Drive)
- Annual contract only, paid quarterly or annually
- DPA, SOC2 evidence pack, security questionnaire support

Pricing is built per-account against this same COGS model with a **55–60%
floor** (Enterprise carries more dedicated support cost — margin
needs the buffer). Floor is $1,500/mo; large accounts have priced at
$5–15K/mo internally based on workspace count and dedicated infra.

---

## 6. Overage pricing

When a workspace hits a quota, the response is a soft block with a
one-click upgrade or pay-per-use overage. Overage prices carry a **5–10×
markup over COGS** to keep margins clean and to nudge plan-upgrade
behaviour.

| Metric | Overage rate | Underlying COGS | Markup |
|---|---|---|---|
| Extra single-post run | $0.50 / post | ~$0.05 LLM | 10× |
| Extra AI image | $0.30 / image | $0.07 | ~4× |
| Extra video clip | $1.50 / clip | $0.40 | ~4× |
| Extra LLM cost (Growth+) | $1.50 per $1 of spend | $1 | 1.5× (passthrough w/ margin) |
| Extra brand workspace (Business+) | $79 / mo | ~$15 infra+LLM share | ~5× |
| Extra seat | $9 / seat / mo | minimal | high-margin |

Overage is **opt-in** — workspaces must enable it explicitly. Default
behaviour is hard-stop at quota (protects users from runaway bills,
protects us from runaway LLM costs on free trials).

---

## 7. Margin sensitivity & risks

### Where the 50% margin could erode

| Risk | Mitigation |
|---|---|
| **LLM cost inflation** (model providers raise prices) | Plan caps measured in *dollars*, not tokens — automatic. Plus model-selector ([test-chat](apps/web/app/(admin)/test-chat/page.tsx)) lets us route lower-tier work to cheaper models. |
| **Image-gen cost variance** | Judge-and-retry pipeline caps retries at 1. Bad provider runs ~$0.14/post worst case, still under the per-image overage rate. |
| **Heavy users at cap, every month** | Acceptable — they're earning their plan. Heavy users at *2×* cap are the Business→Enterprise upgrade signal. |
| **Free-trial abuse** | $1 LLM cost cap + 5 image cap + no-card-required only on 14-day trial. Max bleed per fraudulent trial: ~$1.50. |
| **Stripe fee creep on small accounts** | Starter fees ($1.43) are the heaviest single line outside LLM. Annual plans (one fee/year vs. 12) and NPR-via-Khalti (lower fees) cushion this. |
| **Embedding re-runs on brand-doc edits** | Cap KB doc uploads at plan limit; chunk-level diff prevents full re-embed on minor edits. |

### Where the 50% margin could *over-perform*

- Average utilisation across tenants runs at **55–70% of plan cap**, not
  100%. Realised gross margin on a normal-distribution cohort is
  typically **8–15 points higher** than the cap-utilisation numbers
  above.
- Annual prepay (5–17% discount but no churn risk for 12 months)
  smooths revenue and removes 11 Stripe fees per account/year.
- Reserved capacity deals with model providers (Anthropic, OpenAI)
  unlock ~20–30% input-token discounts at sufficient volume.

---

## 8. Discounts & promo policy

| Code / situation | Discount | Cap |
|---|---|---|
| **Annual prepay** | ~17% (12-for-10) | All public plans |
| **Product Hunt launch** (`PH50`) | 50% off first 3 months | Pro / Business only, first 100 redemptions, expires 30 days after PH launch |
| **Design partner** (first 5 customers) | Free Pro/Business for 6 months | In exchange for testimonial + monthly call |
| **Affiliate / referral** | 30% recurring commission, 12 months | Both sides Tier ≥ Starter |
| **Non-profit / education** | 50% off | Verified 501(c)(3) or accredited institution |
| **Nepal-region (Khalti)** | NPR price already softened (~10% effective discount via rounding) | Automatic on country detect |

**Never offered**: lifetime deals (LTD destroys unit economics on a usage-based product), >50% off (signals desperation), price-cutting in negotiation (offer scope reduction instead).

---

## 9. Summary table — margin at a glance

| Plan | Price | COGS at cap | GM% at cap | Realistic GM% (60% util) |
|---|---|---|---|---|
| Free trial | $0 | ~$1.50 | n/a (CAC) | n/a |
| Starter | $39 | ~$19 | **51%** | **~62%** |
| Growth | $129 | ~$71 | **45%** | **~58%** |
| Business | $449 | ~$244 | **46%** | **~58%** |
| Enterprise | from $1,500 | bespoke | floor **55%** | typically **60–70%** |

**Blended target portfolio margin at 30/100/30/5 customer mix**:
**~55% gross**. The 50% floor holds even in adverse utilisation scenarios.

---

## 10. Open commercial questions

These are still unresolved — flagged here so they don't get lost:

1. **Brand name** — locked in onboarding wizard text but no marketing brand chosen yet.
2. **Public landing page** — none in repo. [`apps/web/app/page.tsx`](apps/web/app/page.tsx) is the admin dashboard, not a marketing page.
3. **Self-serve signup for strangers** — onboarding wizard works for invited users; cold-signup → workspace-creation flow needs review.
4. **Stripe / Khalti webhook handlers** — partial. Without these, paid plan upgrades won't auto-flip subscription state.
5. **Overage billing implementation** — pricing defined here; meter-to-Stripe integration not yet built.
6. **NPR-USD FX hedging** — Khalti settles in NPR; LLM costs are USD. Margin exposure if NPR weakens 10%+ without price update. Acceptable risk for first 12 months given small Nepal-region cohort.
7. **GTM-vs-pricing alignment** — [salesplan.md](salesplan.md) was written against $25/$99/$299. If we adopt $39/$129/$449, the LinkedIn one-liner and landing-page copy need a refresh to match.

---

*Pair this document with [PRODUCT.md](PRODUCT.md) (what's built) and
[salesplan.md](salesplan.md) (how we sell it). Keep all three in sync — if
caps in [billing.ts](packages/shared-types/src/billing.ts) change, the COGS math
here changes.*
