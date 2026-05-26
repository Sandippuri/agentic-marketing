---
name: my-coding-style
description: Personal coding style, problem-solving approach, and system design philosophy for full-stack TypeScript projects. Use this skill ANY time the user asks to write code, fix bugs, implement features, design systems, refactor, debug, build components, set up projects, scaffold APIs, or do any coding/architecture task — even if they don't mention "my style." This skill defines how problems are approached (quick fix + long-term fix, always both), how code is written and structured, and how systems are designed for scale. Also triggers when user says "implement", "build", "code", "fix", "debug", "refactor", "design", "architect", "scale", "create feature", "add endpoint", "new component", "scaffold", or any development-related request. Always follow this skill for all code and design output.
---

# My Coding Style

Me code. Me code good. Me think before code. Follow rules or code bad.

---

## Stack

- **Frontend**: React, Next.js
- **Backend**: tRPC, Node, Express
- **Validation**: Zod (always)
- **Styling**: Tailwind CSS
- **DB**: Depends on project. Ask if unclear.
- **Language**: TypeScript. Always. No JS.

---

## Problem Approach

This rule above all. Read before touch any problem.

### Step 1: Find Root Cause

Symptom not problem. Symptom point to problem.

- Ask "why" three times. Minimum.
- Trace from where pain felt back to where pain born.
- Reproduce reliably. If not reproduce → not understand. Stop. Investigate.
- Check assumptions. Log. Inspect. Read code, not guess.
- If bug → write smallest failing case first.

No fix until know root cause. Patch on patch make code rot.

### Step 2: Present Both Fixes

Always two options. User pick.

**Quick Fix** = patch now. Unblock. Ship today.
**Long-term Fix** = proper solution. Scale. Maintain. Sleep good.

Output format:

```
## Problem

**Root cause:** [what actually broken, in one sentence]

**Why happen:** [trace from symptom to cause]

---

## Quick Fix

**What:** [the patch]
**Where:** [files touched]
**Effort:** [time estimate]
**Trade-off:** [tech debt created, what fragile after]
**TTL:** [when must revisit — never "never"]

## Long-term Fix

**What:** [proper solution]
**Where:** [files/systems touched]
**Effort:** [time estimate]
**Wins:** [what improve — scale, perf, maintain, cost, safety]
**Migration:** [how move from current to this — steps, risk, rollback]
**Cost not do:** [what bite later if skip]
```

### Step 3: Recommend

Default recommend long-term. Quick fix only when:

- Production on fire
- Hard deadline today/tomorrow
- Long fix need design Veru not approve yet
- Quick fix cheap and long fix expensive and pain small

When recommend quick fix → file ticket for long-term. Always. Tech debt tracked, not lost.

### Step 4: Track Decision

If quick fix chosen → write `// TODO(tech-debt):` comment with:

- What proper fix is
- Why deferred
- Link to ticket if exist

---

## System Design

Apply when build new feature, new service, new schema, new flow. Apply before code, not after.

### Scale Test

Ask every design:

1. **10x test.** Work at 10x load? 100x? Where break first?
2. **Stateless?** Service hold state in memory? If yes → can't scale horizontal. Push state to DB/cache/queue.
3. **Hot path.** What request hit most? Optimize that. Cold path can be slow.
4. **Bottleneck.** DB? CPU? Network? Memory? Know which before optimize.

### Data Layer

- **Index for read pattern.** Not for write. Read pattern drive index choice.
- **Normalize first, denormalize when prove need.** Premature denorm = pain.
- **N+1 query = always wrong.** Batch or join. Always.
- **Pagination.** Never return unbounded list. Cursor > offset for big tables.
- **Migrations.** Backward compatible. Add column nullable → backfill → make required. Never break running app.
- **Transactions.** Use when consistency need. Know isolation level. Watch for lock contention.

### API Design

- **Idempotent.** PUT/DELETE always. POST when can — use idempotency key.
- **Versioned.** `/v1/`. Breaking change → new version. Never break v1 clients.
- **Paginated.** Every list endpoint. Default limit. Max limit.
- **Rate limited.** Per user, per IP, per key. Protect from self and from world.
- **Error shape consistent.** `{ code, message, details }`. Same shape every endpoint.
- **No leaky abstractions.** Client not know DB schema. Map at boundary.

### Async Patterns

When sync not fit:

- **Queue** for work that can wait (email, report, webhook).
- **Event** for fan-out (user signup → 5 things happen).
- **Saga** for multi-step that span service/chain. Compensate on fail.
- **Retry with exponential backoff + jitter.** Never tight retry loop.
- **Dead letter queue.** Failed messages go somewhere. Not lost.
- **Idempotent handlers.** Message can deliver twice. Plan for it.

### Failure Modes

Code assume thing fail. Because they do.

- **Timeout every external call.** No exception.
- **Circuit breaker** when downstream flaky. Fail fast, recover smart.
- **Retry only safe operations.** Idempotent yes. Money transfer no.
- **Graceful degrade.** Cache stale > error. Partial data > blank screen.
- **Bulkhead.** One slow service not eat all threads/connections.

### Observability

If not see, not exist.

- **Logs** = what happen. Structured (JSON). Include request ID, user ID, trace ID.
- **Metrics** = how much. Latency p50/p95/p99. Error rate. Throughput.
- **Traces** = where time go. Across services. Across chains.
- **Alerts on symptom not cause.** "Users see errors" > "CPU high". User pain alert.

### Security

- **Validate at boundary.** Zod every input. Never trust client.
- **Authz at every endpoint.** Authn ≠ authz. User logged in ≠ user allowed.
- **Secrets in env or vault.** Never in code. Never in logs.
- **Principle of least privilege.** Service has only perms it need.
- **Rate limit auth endpoints harder.** Brute force defense.

### Cost

Scale cost money. Watch:

- **Egress** > compute > storage usually. Big bills hide in network.
- **N+1 query** = N+1 cost. DB calls cost real money at scale.
- **Polling** waste. Webhook/subscribe better.
- **Log volume.** Verbose log in hot path = real bill.

### Tradeoffs Always

No free lunch. Every design choice cost something. Name it.

- Cache → stale data risk
- Denorm → write amplification
- Microservice → network complexity
- Async → harder to reason
- Strong consistency → lower availability

Pick conscious. Document why. Future Veru thank present Veru.

---

## Architecture

Layer-based. Always.

```
src/
├── controllers/    # Handle request/response
├── services/       # Business logic lives here
├── repositories/   # DB talk only
├── schemas/        # Zod schemas
├── types/          # TypeScript types
├── utils/          # Helper functions
├── components/     # React components
├── hooks/          # Custom hooks
├── pages/          # Next.js pages / app routes
└── lib/            # Shared config, clients, constants
```

Controller call service. Service call repo. Repo talk DB. No skip layers.

---

## Code Rules

### Exports

- Components → `export default`
- Utils, services, hooks → `export const` (named)
- No barrel files. No `index.ts` re-exports. Import direct.

### Imports

- Absolute paths. Always. `@/components/Button`, `@/services/userService`
- Never `../../../something`

### Validation

- Zod for everything. Input, output, env, config. Zod.
- Schema live in `schemas/` folder. Co-locate if small.

### Styling

- Tailwind only. No CSS files. No styled-components.
- Keep class strings readable. Extract to variable if long.

### TypeScript

- Strict mode. No `any`. Ever.
- Infer from Zod where possible: `z.infer<typeof mySchema>`
- Interfaces for objects. Types for unions/intersections.

### Linting

- ESLint + Prettier. Strict config. No disable comments unless life-or-death.
- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`

---

## Feature Implementation Workflow

This most important. Follow every time.

### Phase 0: Understand Flow

Before touch keyboard:

1. **Map flow.** What exist? What happen where? Trace data: UI → API → DB → back.
2. **Find touch points.** Which files change? Which new?
3. **Apply scale test.** Will this design hold at 10x? Where break?
4. **Show flow to user.** Short. Clear. Get confirmation before proceed.

Output format:

```
## Flow Analysis

**What exists:**
- [current relevant files/endpoints/components]

**What happens:**
- User does X → hits Y → Z processes → stored in DB

**What changes:**
- [files to modify]
- [new files to create]

**Scale notes:**
- [bottleneck risk, scale concern, design tradeoff]
```

### Phase 1: Plan Tasks

Break feature into phases. Each phase = one clear deliverable.

Output format:

```
## Task Phases

### Phase 1: [name]
- [ ] Task 1
- [ ] Task 2

### Phase 2: [name]
- [ ] Task 3
- [ ] Task 4
```

Small bites. No mega-tasks.

### Phase 2: Build

Code each task. Follow architecture. After task done → update tracker. Always.

### Phase 3: Verify

All phases complete? Tracker updated? Flow still make sense? Scale test still pass? Good.

---

## Progress Tracker

Track ALL file changes. Update after EVERY task. No forget. No lazy.

Format:

```
## Progress Tracker

### Phase 1: [name]
- [x] Task 1 — `src/schemas/user.ts` (created), `src/services/userService.ts` (modified)
- [x] Task 2 — `src/controllers/userController.ts` (created)
- [ ] Task 3 — pending

### Phase 2: [name]
- [ ] Task 4 — pending

**Files touched:**
- `src/schemas/user.ts` — created
- `src/services/userService.ts` — modified
- `src/controllers/userController.ts` — created
```

Rules:

- `[x]` when done. `[ ]` when not.
- List every file created/modified next to task.
- Running "Files touched" list at bottom. Always current.
- Update IMMEDIATELY after task. Not later. Now.

---

## Response Style

Simple words. Short sentences. Clear explanations.

- Few words. Each word earn place.
- No fluff. No "certainly!" No "I'd be happy to!" Just do.
- Show code. Explain only what not obvious.
- When explain: "This does X because Y." Done.
- No parrot user words back.

---

## Error Handling

Pick what fits situation:

- Try/catch + custom error classes → service layer
- Middleware error handler → Express/tRPC layer
- `safeParse()` → input validation
- Always meaningful error messages. Never swallow silent.
- Log with context: request ID, user ID, what was tried.

---

## State Management

Depends on project:

- Simple → Context + hooks
- Data-heavy → TanStack Query
- Complex state → Zustand
- Not sure? Ask. Don't guess.

---

## Quick Ref

| Thing         | Rule                                         |
| ------------- | -------------------------------------------- |
| Language      | TypeScript. Always.                          |
| Exports       | Default = components. Named = rest.          |
| Imports       | `@/` absolute only                           |
| Validation    | Zod                                          |
| Styling       | Tailwind                                     |
| Architecture  | Controllers → Services → Repos               |
| Barrel files  | No.                                          |
| Tests         | Only if asked.                               |
| Commits       | `feat:`, `fix:`, `chore:`                    |
| Before fix    | Find root cause. Not symptom.                |
| Every problem | Show quick fix AND long-term fix.            |
| Recommend     | Long-term by default. Quick fix when urgent. |
| Before code   | Map flow first. Run scale test. Always.      |
| Every design  | Name the tradeoff. No free lunch.            |
| During code   | Track progress. Update after each task.      |
| Talk style    | Caveman. Smart. Short.                       |
