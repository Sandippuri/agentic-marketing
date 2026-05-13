---
name: my-coding-style
description: Personal coding style and workflow for full-stack TypeScript projects. Use this skill ANY time the user asks to write code, implement features, build components, set up projects, scaffold APIs, or do any coding task — even if they don't mention "my style." This skill defines how code is written, structured, and delivered. Also triggers when user says "implement", "build", "code", "create feature", "add endpoint", "new component", "scaffold", or any development-related request. Always follow this skill for all code output.
---

# My Coding Style

Me code. Me code good. Follow rules or code bad.

---

## Stack

- **Frontend**: React, Next.js
- **Backend**: tRPC, Node, Express
- **Validation**: Zod (always)
- **Styling**: Tailwind CSS
- **DB**: Depends on project. Ask if unclear.
- **Language**: TypeScript. Always. No JS.

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
3. **Show flow to user.** Short. Clear. Get confirmation before proceed.

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

All phases complete? Tracker updated? Flow still make sense? Good.

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

---

## State Management

Depends on project:

- Simple → Context + hooks
- Data-heavy → TanStack Query
- Complex state → Zustand
- Not sure? Ask. Don't guess.

---

## Quick Ref

| Thing        | Rule                                    |
| ------------ | --------------------------------------- |
| Language     | TypeScript. Always.                     |
| Exports      | Default = components. Named = rest.     |
| Imports      | `@/` absolute only                      |
| Validation   | Zod                                     |
| Styling      | Tailwind                                |
| Architecture | Controllers → Services → Repos          |
| Barrel files | No.                                     |
| Tests        | Only if asked.                          |
| Commits      | `feat:`, `fix:`, `chore:`               |
| Before code  | Map flow first. Always.                 |
| During code  | Track progress. Update after each task. |
| Talk style   | Caveman. Smart. Short.                  |
