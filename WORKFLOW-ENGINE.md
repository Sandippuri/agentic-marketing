# Workflow Engine — Architecture Reference

How the existing chat / component-generation workflow runs **step-by-step without pausing**, and how to lift the same pattern into a **manager-orchestrator agentic platform** (e.g. for marketing campaigns).

This doc is grounded in the actual code in this repo. File:line references throughout.

---

## 1. The Big Idea (read this first)

There is **no workflow engine** in the classic sense. There is no state machine, no DAG, no LangGraph, no job queue. The "workflow" is produced by three primitives working together:

1. **An LLM with tool-use** decides what step happens next.
2. **An HTTP streaming response** carries each decision/result to the client as it happens.
3. **A line-prefixed protocol + a `while` loop on the client** dispatches each event to a handler that updates UI state immediately.

The LLM is the "manager." The tools are the "workers." The stream is the "bus." The client loop is the "runtime."

That is the whole pattern. Everything below is mechanism.

```
User input
   │
   ▼
runQuery(message) ──────────► fetch('/chat', stream=true)
                                       │
                                       ▼
                              streamText({ tools, stopWhen: stepCountIs(10) })
                                       │
                                       │  fullStream yields:
                                       │   text-delta → "0:..."
                                       │   tool-call  → "9:..."
                                       │   tool-result→ "a:..." | "f:..." | "p:..."
                                       │   finish     → "d:..."
                                       ▼
                              ReadableStream chunks
                                       │
                                       ▼
                              Client: while ((line = readLine())) dispatch(prefix, payload)
                                       │
                                       ├─ "0" → setResponseText(text)         (text streams in)
                                       ├─ "f" → openForm(payload)             (form appears mid-stream)
                                       ├─ "p" → openPanel(payload)            (panel morphs in)
                                       ├─ "a" → handleToolResult(payload)     (scroll / annotate)
                                       └─ "d" → break                         (turn complete)
```

**"Unpaused" comes from one fact:** after each tool-call, the LLM is *not* asked again — it is already in a multi-step `streamText` call that auto-loops up to `stopWhen: stepCountIs(10)` ([handler.ts:513](../src/server/conversation/handler.ts)). So the LLM keeps calling tools and producing text in **one** server response, and the client sees it as one continuous stream.

When the user *does* need to be in the loop (a form), the workflow stops streaming, the form is rendered, the user fills it, and the form submission is **re-injected as the next user message** — re-entering `runQuery` with the form JSON embedded in the prompt ([$.tsx:2106–2176](../src/routes/page/$projectSlug/$.tsx)). That is the only "pause."

---

## 2. Anatomy of a Run

### 2.1 Entry point — the user submits text

[`src/routes/page/$projectSlug/$.tsx:2785`](../src/routes/page/$projectSlug/$.tsx)

```ts
async function onSubmit(e: FormEvent) {
  e.preventDefault()
  const message = input.trim()
  if (!message) return
  setInput('')
  await runQuery(message)
}
```

`runQuery` is the orchestrator on the client side. Definition: [$.tsx:2518–2783](../src/routes/page/$projectSlug/$.tsx).

### 2.2 Fast path — local intent cache

Before calling the server, `runQuery` looks the message up against pre-computed intents stored in memory ([$.tsx:2524–2555](../src/routes/page/$projectSlug/$.tsx)):

- High/medium-confidence match → return the cached reply, optionally `openForm()` from the intent's attached form spec.
- Miss → continue to the LLM path.

This is purely an optimization. For your manager platform, ignore this layer until you actually need it.

### 2.3 Server orchestration

The chat endpoint ([`src/routes/api/$projectSlug.$pageSlug.chat.ts`](../src/routes/api/$projectSlug.$pageSlug.chat.ts)) calls `createStreamingConversation()` in [`src/server/conversation/handler.ts:364–580`](../src/server/conversation/handler.ts).

That function:

1. Loads context (prior messages, page metadata, intents).
2. Builds the system prompt — including two **capability prompts** that *teach* the LLM when to call which tool:
   - `FORM_CAPABILITY_PROMPT` ([handler.ts:39–60](../src/server/conversation/handler.ts)) — "use `requestForm` whenever you need structured input."
   - `PANEL_CAPABILITY_PROMPT` ([handler.ts:62–83](../src/server/conversation/handler.ts)) — "use `showPanel` for visual summaries."
3. Assembles the toolset ([`src/server/conversation/tools.ts`](../src/server/conversation/tools.ts)): `showSection`, `annotateSection`, `openKnowledgeDialog`, `showPanel`, `requestForm`, plus any MCP tools.
4. Calls `streamText()`:

   ```ts
   const result = streamText({
     model: successCtx.modelClient,
     temperature: 0.2,
     system: systemPrompt,
     prompt: successCtx.userPrompt,
     tools: allTools,
     stopWhen: stepCountIs(10),  // ← THE multi-step loop
   })
   ```

   `stepCountIs(10)` is the magic: the AI SDK will let the model call up to 10 tools in sequence inside this *single* `streamText` call, feeding each tool result back to the model and letting it decide the next step. The server never "starts a new turn" between tool calls.

### 2.4 The wire format

[`src/routes/api/$projectSlug.$pageSlug.chat.ts:108–207`](../src/routes/api/$projectSlug.$pageSlug.chat.ts)

The server walks `result.fullStream` and writes line-prefixed JSON to a `ReadableStream`:

| Prefix | Event           | Body                                                  |
|--------|-----------------|-------------------------------------------------------|
| `0:`   | text delta      | JSON-encoded string                                   |
| `9:`   | tool call start | `{ name, args }`                                      |
| `a:`   | tool result     | `{ name, result }` — generic action                   |
| `f:`   | form request    | full form payload (sniffed from a tool result)        |
| `p:`   | panel request   | full panel payload (sniffed from a tool result)       |
| `d:`   | done            | `{}`                                                  |
| `e:`   | error           | `{ message }`                                         |

`f:` and `p:` are a small shortcut: when a tool result has `action: 'form_request'` or `action: 'panel_request'`, the server *also* emits a dedicated event so the client doesn't have to crack open every `a:` payload.

### 2.5 The client runtime

[`$.tsx:2654–2758`](../src/routes/page/$projectSlug/$.tsx)

```ts
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    const prefix = line.slice(0, colonIdx)
    const payload = line.slice(colonIdx + 1)
    switch (prefix) {
      case '0': accumulatedText += JSON.parse(payload); setResponseText(accumulatedText); break
      case 'f': openForm(JSON.parse(payload), accumulatedText); break
      case 'p': openPanel(JSON.parse(payload)); break
      case 'a': handleToolResult(JSON.parse(payload)); break
      case 'd': /* done */ break
    }
  }
}
```

That is the entire client-side workflow runtime. Every event from the LLM lands here and is dispatched to a UI mutator. React re-renders. The user sees text appear, forms slide in, panels morph — all as a single uninterrupted run.

### 2.6 Re-entry on form submit

When the LLM calls `requestForm`, the run effectively pauses (the LLM has to wait for the user). The form payload is rendered. On submit ([$.tsx:2106–2176](../src/routes/page/$projectSlug/$.tsx)):

```ts
const wrapped = `[FORM_SUBMISSION_JSON]${JSON.stringify({form_id, values, ...})}[/FORM_SUBMISSION_JSON]`
await runQuery(wrapped)
```

The next server turn parses that envelope ([handler.ts:103–129](../src/server/conversation/handler.ts)) and surfaces the structured data to the LLM. From the LLM's perspective, the run continues — it knows the form was answered and decides the next tool call.

---

## 3. State & Context

### 3.1 What carries state between steps

| Layer  | Holder                          | Lifetime            |
|--------|---------------------------------|---------------------|
| Within one `streamText` call | AI SDK message array (auto) | one server response |
| Across user turns            | D1 `messages` table         | persistent          |
| Within the streamed response | `accumulatedText` + React state in the client loop | one stream |
| Form state                   | `activeForm` React state    | until submit/timeout|

Important: the LLM does **not** maintain memory between user turns on its own. Each new turn rebuilds the prompt by reading prior messages from D1 and re-injecting them. So "state" in this system is really "conversation history + last tool result."

### 3.2 What is **not** persisted

- In-flight workflow position. Reload the browser mid-form and the form is gone.
- Tool-call sequence. The LLM may take a different path on the next turn.
- Panel/annotation interactions. Visual ephemera only.

For your platform you will likely need to persist more (see §6).

---

## 4. What "unpaused" actually means here

Re-reading the trace, three distinct things let it run uninterrupted:

1. **`stopWhen: stepCountIs(10)`** lets the LLM call multiple tools inside one server call without a network round-trip per step. This is the loop.
2. **HTTP streaming** lets the server flush each step's output as it happens — no polling, no SSE infra, just `ReadableStream` on `fetch`.
3. **A single `while` loop on the client** dispatches every event without waiting. UI updates are the side-effect of state mutations triggered by stream events.

The only legitimate "pause" is when human input is required (a form). That pause is **explicit**: the LLM emits `requestForm`, the client renders it, the user submits, and the run resumes via re-entry into `runQuery`.

There is also an **implicit cap**: at 10 steps, `stopWhen` halts the run. If you need longer chains for your manager platform, raise this limit or replace it with a goal-based predicate (see §6.3).

---

## 5. Termination & Error Handling

| Case                           | Behaviour                                                  | Where |
|--------------------------------|------------------------------------------------------------|-------|
| LLM finishes naturally         | `d:` event, client loop reads `done=true`, breaks          | [$.tsx:2720](../src/routes/page/$projectSlug/$.tsx) |
| Hits `stepCountIs(10)`         | Stream ends; whatever has streamed is what the user sees   | [handler.ts:513](../src/server/conversation/handler.ts) |
| LLM error / no API key         | Server returns error response with friendly text           | [handler.ts:427–443](../src/server/conversation/handler.ts) |
| Network abort                  | Client catches `AbortError`, shows "something went wrong"  | [$.tsx:2774](../src/routes/page/$projectSlug/$.tsx) |
| Malformed line in stream       | Silently ignored (`try`/`catch` around `JSON.parse`)       | [$.tsx:2678, 2685](../src/routes/page/$projectSlug/$.tsx) |
| Form validation fails          | Shake field, no advance                                    | [$.tsx:2109–2117](../src/routes/page/$projectSlug/$.tsx) |
| Form idle 3 min                | Auto-dismiss with friendly message                         | [engine.ts:223](../src/server/renderer/engine.ts) |

There is **no retry** anywhere. Failures surface to the user as messages.

---

## 6. Lifting this for a Manager-Orchestrator Marketing Platform

Your goal: a campaign kicks off, a manager agent decides which sub-task to do next and which specialist agent to dispatch, and the run continues until the campaign is complete.

The pattern in this repo gives you the runtime for free. Here is the mapping and what to add.

### 6.1 Direct mapping

| This repo                     | Your platform                          |
|-------------------------------|----------------------------------------|
| `runQuery()` client loop      | Campaign run loop (server-side, not browser) |
| `streamText` + tools          | Manager LLM + specialist agents as tools |
| `requestForm`                 | "ask user to approve" / human-in-the-loop checkpoint |
| `showPanel`, `annotateSection`| Per-step UI updates / dashboard events |
| D1 messages table             | Campaign run table (persistent state)  |
| Stream prefixes               | Event log for the dashboard (websocket / SSE) |
| `stopWhen: stepCountIs(10)`   | `stopWhen: goalAchieved(campaign)`     |

### 6.2 The loop you actually want

```ts
while (!campaign.done) {
  const decision = await managerLLM.decide({
    goal: campaign.goal,
    completedSteps: campaign.steps,
    availableAgents: registry.list(),
  })

  if (decision.kind === 'dispatch') {
    const result = await agents[decision.agent].run(decision.input, campaign.context)
    campaign.steps.push({ agent: decision.agent, input: decision.input, result })
    persist(campaign)
    emit('step.done', { agent: decision.agent, result })   // ← stream to UI
  }

  if (decision.kind === 'await_human') {
    await waitForApproval(decision.requestId)              // ← only legit pause
  }

  if (decision.kind === 'finish') {
    campaign.done = true
  }
}
```

Two ways to implement `managerLLM.decide`:

- **Tool-call style (mirrors this repo):** one `streamText` call where each specialist agent is a tool. The LLM calls `tool('seo_writer', {...})`, the tool internally runs that agent, returns its output, and the LLM picks the next tool. Use `stopWhen` with a predicate that checks whether the campaign goal is satisfied. Cleanest if you trust the LLM to drive.
- **Outer-loop style:** the manager LLM only outputs JSON like `{ next_agent, input, reason }`. Your code dispatches it, persists the result, then calls the manager again with updated state. More control, more durable, easier to resume after a crash. **Recommended for long-running marketing campaigns.**

### 6.3 What you must add that this repo doesn't have

1. **Durable run state.** Persist every step result before emitting it. A campaign that runs for hours/days can't live in browser React state. Use Postgres/D1 with a `campaign_runs` table holding `{ id, goal, status, current_step, steps: jsonb, context: jsonb }`.
2. **Resumability.** On crash/restart, load the run, replay the manager with `completedSteps`, continue. The current chat workflow is not resumable — you must build this.
3. **Goal predicate instead of step cap.** Replace `stepCountIs(10)` with `stopWhen: ({ steps }) => goalChecker(campaign.goal, steps)`. Without this you either over-cap and stall, or uncap and burn tokens.
4. **Specialist agent registry.** Each agent has: name, description (the LLM reads this to choose), input schema (zod), output schema, and a `run(input, ctx)` function. Keep it flat; let the manager pick.
5. **Event bus to the dashboard.** The chat workflow uses raw HTTP streaming because there's exactly one client. For a campaign dashboard you'll want websockets or SSE, with events like `step.started`, `step.finished`, `agent.thinking`, `human_input.required`. Same line-prefixed idea, just over a real pub/sub channel.
6. **Human checkpoints as first-class.** Generalize `requestForm` to `request_human(reason, schema)`. Persist the request, surface in the UI, and resume the loop on submit. Without persistence this is the same brittle pause as the current form flow.
7. **Concurrency control.** Marketing tasks can fan out (write 5 ad variants in parallel). Add a `dispatch_parallel` decision kind that runs N agents concurrently and joins.
8. **Per-step retries with backoff.** The chat workflow has none. For real agents calling external APIs you want at least one retry with exponential backoff before surfacing the error to the manager (which can then decide to skip / try a different agent).
9. **Observability.** Log every `decide → dispatch → result` with timings. You will need this to debug why the manager picked a bad agent.
10. **Cost / step budget.** A separate guardrail from the goal predicate. `if (campaign.tokensSpent > budget) halt('budget_exceeded')`.

### 6.4 Suggested file layout (if you scaffold from scratch)

```
src/server/campaign/
  engine.ts          # the while-loop above
  manager.ts         # managerLLM.decide() — tool-style or JSON-style
  registry.ts        # agent registry
  agents/
    seo_writer.ts
    ad_copy.ts
    image_brief.ts
    audience_research.ts
  state.ts           # load/save campaign run from DB
  events.ts          # event bus → SSE/WebSocket
  predicates.ts      # goalAchieved, budgetExceeded
src/routes/api/
  campaign.start.ts  # POST → create run, kick off engine in background
  campaign.events.ts # GET (SSE) → stream events for a run
  campaign.approve.ts# POST → resolve a human checkpoint
```

---

## 7. Files to read in this repo (in order)

1. [`src/routes/page/$projectSlug/$.tsx:2518–2783`](../src/routes/page/$projectSlug/$.tsx) — `runQuery`, the client runtime.
2. [`src/routes/api/$projectSlug.$pageSlug.chat.ts`](../src/routes/api/$projectSlug.$pageSlug.chat.ts) — the streaming endpoint and wire format.
3. [`src/server/conversation/handler.ts:364–580`](../src/server/conversation/handler.ts) — `createStreamingConversation`, the server orchestrator with `stopWhen`.
4. [`src/server/conversation/tools.ts`](../src/server/conversation/tools.ts) — tool definitions (your "agents" go here in tool-call style).
5. [`src/server/conversation/schemas.ts`](../src/server/conversation/schemas.ts) — zod schemas for tool/form/panel payloads.
6. [`src/routes/page/$projectSlug/$.tsx:2106–2176`](../src/routes/page/$projectSlug/$.tsx) — `submitActiveForm`, the human-in-the-loop re-entry pattern.
7. [`src/server/conversation/handler.ts:39–83`](../src/server/conversation/handler.ts) — capability prompts that teach the LLM when to call which tool. **You'll write equivalents to teach your manager when to dispatch which agent.**

---

## 8. TL;DR

- The "unpaused" workflow is just `streamText({ tools, stopWhen })` running multi-step on the server, plus a `while` loop on the client that dispatches streamed events to UI mutators.
- The LLM is the planner. Tools are the workers. Streaming is the bus.
- Human pauses are explicit (`requestForm`) and resume by re-injecting the result as the next user message.
- For your campaign platform: keep the same shape, but move the loop server-side, persist state per step, replace `stepCountIs` with a goal predicate, and add a durable event bus for the dashboard.
