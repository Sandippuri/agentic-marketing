# Manager memory

Git-tracked Markdown read by the Manager's sub-agents. Plan §2.

- `brand/voice.md` — tone, do/don't, banned phrases. Strategist + Content read every run.
- `brand/icp.md` — target personas. Strategist + Content read every run.
- `brand/visual.md` — palette, typography, banned looks. Asset reads every run (Phase 6.5).
- `product/state.md` — what's true about the product right now. Strategist + Content.
- `product/positioning.md` — the 2-3 core ideas (Strategist step 2). Strategist primary reader.
- `channel-sops/linkedin.md` — character limits, hashtag rules, structure by stage, engagement window.
- `channel-sops/x.md` — thread vs single, link placement, scheduling.
- `channel-sops/email.md` — subject line rules, body structure, send-time heuristics.
- `channel-sops/internal-blog.md` — heading style, length, OG image, syndication notes.
- `campaigns/<slug>.md` — per-campaign brief and notes. Loaded when that campaign is in scope.
- `learnings/<yyyy-mm>.md` — Analyst-written insights. Strategist reads recent months on every plan.
- `playbooks/<name>.md` — repeatable patterns; e.g. `launch-week.md`.

## Used by findBrandGuidance

`brand-guidance.ts` scans `brand/`, `channel-sops/`, and `playbooks/` for semantic retrieval.
Run order: brand context first, then channel-specific SOPs, then any matching playbooks.

Treat as semi-public: do NOT commit secrets, customer names without consent, or unreleased product details.
