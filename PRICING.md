# PRICING.md

> Product framing + pricing built backwards from real COGS so every paid tier
> nets ~50% gross margin **at maximum entitlement use** (worst case), not just
> at average consumption.
>
> Companion doc to [PRODUCT.md](PRODUCT.md). Last updated 2026-05-16.

---

## 1. The product, in one sentence

**An AI marketing team that ships campaigns end-to-end — strategy, copy,
images, video, scheduling, analytics — and gets sharper with every approval.**

The execution-and-memory layer underneath a single human marketer. One operator
+ this product covers what a 3–5 person content team would do.

### What it actually does (capabilities buyers pay for)

| Capability | What ships today |
|---|---|
| **Strategy** | Strategist agent builds 4-week briefs + content calendars, citing past wins. |
| **Content** | Drafts platform-native copy for LinkedIn, X, Instagram, Facebook, blog, email. |
| **Images** | Art Director → image gen → vision judge → retry pipeline. ~$0.07/post. |
| **Video** *(Business+)* | Generated short-form clips for Reels/Shorts/X. |
| **Publishing** | LinkedIn, X, Instagram, Facebook, HubSpot, Mailchimp, internal blog. Scheduled + rate-limited. |
| **Brand intelligence** | 6 brand-memory slugs + design system + market context + KB read on every run. |
| **Closed learning loop** | Approval decisions + outcomes → weekly playbook lessons → next draft. |
| **Multi-tenant SaaS** | Workspace isolation, RBAC, per-workspace quotas + cost caps. |
| **Observability** | Per-run cost, per-step pipeline, per-channel insights, full audit log. |

Full feature inventory and what's still in progress: see [PRODUCT.md](PRODUCT.md).

### Buyer (ICP)

Primary: **B2B SaaS founders (0–25 employees)** spending 5–15 hrs/week on content,
or paying a $2–4K/mo agency for the same output.

Secondary (post month 3): **boutique marketing agencies** running 3–10 client brands.

Positioning: *Replaces a $3,000/mo agency with $99–$499/mo of agentic software.*

---

## 2. COGS — what every active workspace costs us

Each paid workspace incurs a mix of **variable** (capped per plan) and
**allocated fixed** (amortized across the customer base) costs.

### 2.1 Variable cost components

| Component | Source | Unit cost | How it's capped per plan |
|---|---|---|---|
| LLM tokens | Anthropic / OpenAI / Google | Tracked in `llm_usage` table | `quotas.llm_cost_usd_micros` hard cap |
| Image generation | Replicate / Gemini Nano | **~$0.07 per accepted image** (single shot + 1 retry budget — see [PRODUCT.md §How it works](PRODUCT.md)) | `quotas.asset_pipeline_runs` |
| Video generation | Veo / Runway | **~$0.45 per ≤15s clip** (estimate; production wiring partial) | feature-gated to Business+ |
| Embeddings | OpenAI `text-embedding-3-small` | $0.02 / 1M tokens — negligible | `quotas.kb_embeds` |
| SERP / research | Serper.dev | $0.0006 / search | implicit via web_research feature |

The **hard LLM cap** (`llm_cost_usd_micros` per plan) is the worst-case cost
ceiling. Pricing below assumes the customer hits it.

### 2.2 Allocated fixed cost (per workspace, monthly)

| Bucket | Estimate | Notes |
|---|---|---|
| Supabase (DB + storage + auth) | $2.00 | Amortized across paid workspaces of a Pro Supabase project. |
| Vercel + Vercel Workflows | $1.50 | Hobby-to-Pro headroom; workflows priced per run. |
| Monitoring / logs (Sentry / Axiom) | $0.50 | |
| Domain / email (Resend / WorkOS) | $0.30 | |
| Payment processing | **3.0% of price** | Stripe / Khalti. Scales with price. |
| Support amortization | $1.00 → $10.00 | Scales by tier (Starter ≈ $1, Business ≈ $10). |
| **Subtotal (excl. payment fees)** | **~$5.30 + tier-scaled support** | |

Numbers are deliberately conservative — real per-tenant infra cost on a Pro
Supabase + Vercel setup is closer to $2/workspace until ~200 customers.

---

## 3. Pricing tiers (rebuilt for 50% margin at max consumption)

| Plan | Monthly (USD) | Yearly (USD, 2 months free) | Target buyer |
|---|---|---|---|
| **Free** | $0 | — | Evaluators, trial |
| **Starter** | **$49** | $490 | Solo founder, side project |
| **Growth** | **$169** | $1,690 | SaaS founder, freelance marketer |
| **Business** | **$499** | $4,990 | Small agency, scale-up marketing team |
| **Enterprise** | from **$1,499/mo** | custom | Multi-brand agencies, regulated industries |

> **Why these numbers, not the salesplan's $25/$99/$299?** Those tiers don't
> survive a max-utilization customer at current LLM/image costs — Growth at
> $99 with an $80 LLM cap is a 10% margin, not 50%. The numbers below preserve
> the *positioning* ("replaces a $3K/mo agency") while keeping margin honest.
> If volume discounts on LLM tokens land (likely in 6 months), we can drop
> Starter/Growth toward the original $25/$99 lines and still hit 50%.

### 3.1 Tier detail + margin math

#### Free — $0/mo

| Item | Value |
|---|---|
| Seats | 1 |
| Drafts (single-post runs) / mo | 10 |
| Published posts / mo | 5 |
| LLM hard cap | **$1** |
| Asset pipeline | ❌ |
| Watermarked outputs | ✅ |

COGS at cap: $1 LLM + $0 assets + $3 fixed = **$4**. Subsidized; converts via
forced-upgrade walls (asset pipeline, seat count, kill-switch on $1).

---

#### Starter — $49/mo

| Item | Value |
|---|---|
| Seats | 1 |
| Drafts / mo | 100 |
| Published posts / mo | 60 |
| LLM hard cap | **$15** |
| Asset pipeline | ❌ (manual image upload only) |
| Web research | ❌ |
| Channels | All 7 |
| Brand intelligence + KB | Full read/write |

**COGS at max utilization**:

| Line | $ |
|---|---|
| LLM (capped) | 15.00 |
| Image gen | 0.00 |
| Fixed infra | 5.30 |
| Payment fees (3%) | 1.47 |
| Support amortization | 1.50 |
| **Total COGS** | **$23.27** |
| **Gross margin** | **($49 − $23.27) / $49 = 52.5%** ✓ |

---

#### Growth — $169/mo  ← *flagship tier; replaces "Pro $99"*

| Item | Value |
|---|---|
| Seats | 5 |
| Drafts / mo | 500 |
| Published posts / mo | 300 |
| Asset pipeline runs / mo | 200 |
| LLM hard cap | **$40** |
| Web research | ✅ |
| Goal loop | ✅ |
| Experiments | ✅ |

**COGS at max utilization**:

| Line | $ |
|---|---|
| LLM (capped) | 40.00 |
| Image gen (200 × $0.07) | 14.00 |
| SERP/research (small) | 1.00 |
| Fixed infra | 5.30 |
| Payment fees (3%) | 5.07 |
| Support amortization | 3.50 |
| **Total COGS** | **$68.87** |
| **Gross margin** | **($169 − $68.87) / $169 = 59.2%** ✓ |

---

#### Business — $499/mo

| Item | Value |
|---|---|
| Seats | 15 |
| Drafts / mo | 2,500 |
| Published posts / mo | 1,500 |
| Asset pipeline runs / mo | 1,000 |
| Video clips / mo | 40 |
| LLM hard cap | **$120** |
| Lifecycle sequences | ✅ |
| API access | ✅ |
| Priority queue | ✅ |
| Custom KB collections | ✅ |

**COGS at max utilization**:

| Line | $ |
|---|---|
| LLM (capped) | 120.00 |
| Image gen (1000 × $0.07) | 70.00 |
| Video gen (40 × $0.45) | 18.00 |
| SERP/research | 3.00 |
| Fixed infra | 8.00 |
| Payment fees (3%) | 14.97 |
| Support amortization | 8.00 |
| **Total COGS** | **$241.97** |
| **Gross margin** | **($499 − $241.97) / $499 = 51.5%** ✓ |

---

#### Enterprise — from $1,499/mo (custom)

Floor only. Custom limits, SSO, dedicated infra, SLA, named CSM. Quote per
deal; never sell below $1,499/mo even for "small" enterprise customers —
support load alone amortizes to $100–200/mo before infra.

Target gross margin: **≥ 60%** (because deals are high-touch and any
discount eats fast).

---

### 3.2 Margin summary

| Plan | Price | COGS @ cap | Gross $ | Gross margin |
|---|---|---|---|---|
| Free | $0 | $4 | −$4 | (loss leader) |
| Starter | $49 | $23.27 | $25.73 | **52.5%** |
| Growth | $169 | $68.87 | $100.13 | **59.2%** |
| Business | $499 | $241.97 | $257.03 | **51.5%** |
| Enterprise | $1,499+ | ≤$600 | ≥$899 | **≥60%** target |

All paid tiers clear the 50% floor at the worst-case customer. **Average**
customer uses ~40-60% of cap → blended gross margin will land in the 65-75%
range, which is healthy SaaS territory.

---

## 4. Yearly pricing

Yearly = `monthly × 10` (i.e. ~17% off, or "2 months free"). Locks in cash
flow and reduces churn — even at the discount, paid tiers still clear 50%
margin because allocated fixed costs and payment fees are amortized once.

| Plan | Monthly | Yearly (effective $/mo) | Yearly upfront |
|---|---|---|---|
| Starter | $49 | $40.83 | $490 |
| Growth | $169 | $140.83 | $1,690 |
| Business | $499 | $415.83 | $4,990 |

Margin check on Growth annual: $1,690 − $68.87 × 12 = $864.56 net → 51.2% ✓

---

## 5. Add-ons (margin-positive, all optional)

| Add-on | Price | COGS | Margin |
|---|---|---|---|
| Extra image pack (100 generations) | $19 | $7 | 63% |
| Extra video pack (10 clips) | $19 | $4.50 | 76% |
| Extra LLM credit ($50 of usage) | $79 | $50 | 37% — flagged: bump to $99 for 50% |
| Extra seat (Growth+) | $19/mo/seat | ~$2 | 89% |
| Dedicated brand-onboarding (one-time) | $499 | ~$100 (4 hrs) | 80% |

**Action**: change the "Extra LLM credit" sticker price to **$99** so the cheapest
add-on still clears 50%. Updates pending in `packages/shared-types/src/billing.ts`.

---

## 6. Discounting policy (protects margin)

- **Annual discount**: 2 months free (capped). No deeper.
- **Design partner**: 6 months free Pro/Growth in exchange for written
  testimonial + reference call. Free seats only — usage above cap is still
  charged at cost.
- **Launch promo (PH50)**: 50% off first 3 months on Starter/Growth only.
  Never on Business (margin too thin to discount).
- **Annual contract for enterprise**: discount cap 15%. Below that, the deal
  isn't worth the support load.
- **Never**: lifetime deals (AppSumo, etc.). Usage-priced product + LTD = a
  guaranteed loss when 5% of buyers max out forever.

---

## 7. Implementation diff — what to change in code

These tier numbers don't match `packages/shared-types/src/billing.ts` yet.
The table below is the diff to ship:

| Plan | Current `priceMonthlyUsdCents` | Proposed | Current `llm_cost_usd_micros` | Proposed |
|---|---|---|---|---|
| Free | 0 | 0 | 1,000,000 ($1) | 1,000,000 ($1) ✓ |
| Starter | 2,900 ($29) | **4,900 ($49)** | 20,000,000 ($20) | **15,000,000 ($15)** |
| Growth | 8,900 ($89) | **16,900 ($169)** | 80,000,000 ($80) | **40,000,000 ($40)** |
| Business | 24,900 ($249) | **49,900 ($499)** | 250,000,000 ($250) | **120,000,000 ($120)** |
| Enterprise | 75,000 ($750) | **149,900 ($1,499)** floor | unlimited | unlimited ✓ |

Single source-of-truth file: [packages/shared-types/src/billing.ts](packages/shared-types/src/billing.ts).
After changing, run plan-seed to upsert into the `plans` table.

NPR pricing (Khalti): convert at ~1 USD = NPR 133 and round to nearest 99/999.

---

## 8. What breaks 50% margin (and what to do)

| Risk | Triggers | Response |
|---|---|---|
| LLM unit costs rise | Anthropic / OpenAI pricing change | Re-tighten `llm_cost_usd_micros` caps within 24h; entitlement system already enforces. |
| Heavy abuser on a flat tier | 1% of users do 10× the work | Soft-warn at 80% of cap → hard kill-switch at 100%. Already in `apps/web/lib/billing/`. |
| Image-gen retries blow past 1 | Vision judge rejects too often | Asset pipeline has retry budget = 1; metric already tracked. Tune judge threshold per workspace. |
| Support cost balloons | Free-tier abuse | Limit Free workspaces per email/IP; require email verification before agents run. |
| Currency volatility (NPR) | Khalti settlement vs. LLM USD billing | Hold a 1-month USD float; reprice NPR quarterly. |

---

## 9. North-star unit economics

At blended 65% gross margin and a $169 ARPU (Growth-tier weighted):

- Gross profit / customer / month: ~$110
- Target CAC (12-month payback): ≤ $1,320
- LinkedIn-organic CAC (per salesplan.md): ~$0 → payback in week 1
- Path to $10K MRR: ~60 paying customers (mix of Starter / Growth / Business)
- Path to $30K MRR: ~180 paying customers — the threshold to hire help

---

*Tier numbers in §3 supersede the salesplan.md figures. Update salesplan.md
once these are reflected in [packages/shared-types/src/billing.ts](packages/shared-types/src/billing.ts).*
