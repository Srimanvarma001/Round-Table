# Round Table — Architecture & Build Specification

**Weighted Multi-Agent Idea Generator**

Version 1.1 · Status: Approved for implementation · Target: v1 complete (all six milestones)

**Changelog**
- 1.1 — Section 4.4 and Section 16 rewritten as a full UI design specification: seat layout math, avatar system, motion specs, theme tokens, responsive behaviour. Agent schema extended with avatar fields.
- 1.0 — Initial approved specification.

This document is the single source of truth for building Round Table. It is written to be handed to an implementing agent with no further clarification. Where a decision was made during the design interview, the decision is stated as a requirement and the rationale is given in one line. Anything marked **MUST** is a build requirement, not a suggestion.

---

## Table of Contents

1. [Product Summary](#1-product-summary)
2. [Locked Design Decisions](#2-locked-design-decisions)
3. [System Overview](#3-system-overview)
4. [Technology Stack](#4-technology-stack)
5. [Repository Layout](#5-repository-layout)
6. [Configuration and Secrets](#6-configuration-and-secrets)
7. [Data Model](#7-data-model)
8. [Provider Adapter Layer](#8-provider-adapter-layer)
9. [Agent Definitions and Prompts](#9-agent-definitions-and-prompts)
10. [Me Agent Profile Pipeline](#10-me-agent-profile-pipeline)
11. [Orchestration State Machine](#11-orchestration-state-machine)
12. [Scoring and Voting Math](#12-scoring-and-voting-math)
13. [Streaming and Event Bus](#13-streaming-and-event-bus)
14. [HTTP API Contracts](#14-http-api-contracts)
15. [Frontend Architecture](#15-frontend-architecture)
16. [UI Design Specification — Layout, Avatars, Motion, Theme](#16-ui-design-specification--layout-avatars-motion-theme)
    - [16.1 Seat layout math](#161-seat-layout-math)
    - [16.2 The table surface](#162-the-table-surface)
    - [16.3 Avatar system](#163-avatar-system)
    - [16.4 Seat visual states](#164-seat-visual-states)
    - [16.5 The thinking indicator](#165-the-thinking-indicator)
    - [16.6 Speech bubble and the expand-to-drawer transition](#166-speech-bubble-and-the-expand-to-drawer-transition)
    - [16.7 The table centre during vote](#167-the-table-centre-during-vote)
    - [16.8 Theme system](#168-theme-system)
    - [16.9 Typography, spacing, radii, elevation](#169-typography-spacing-radii-elevation)
    - [16.10 Staggered reveal](#1610-staggered-reveal)
    - [16.11 Responsive behaviour](#1611-responsive-behaviour)
    - [16.12 Reduced motion and accessibility](#1612-reduced-motion-and-accessibility)
    - [16.13 Motion budget and performance rules](#1613-motion-budget-and-performance-rules)
17. [Guardrails, Budgets, and Failure Handling](#17-guardrails-budgets-and-failure-handling)
18. [Run History, Replay, Export, Compare](#18-run-history-replay-export-compare)
19. [Testing Specification](#19-testing-specification)
20. [Milestones and Acceptance Criteria](#20-milestones-and-acceptance-criteria)
21. [Risks and Known Trade-offs](#21-risks-and-known-trade-offs)
22. [Appendix A — Structured Output Schemas](#appendix-a--structured-output-schemas)
23. [Appendix B — Prompt Templates](#appendix-b--prompt-templates)
24. [Appendix C — Model Reference and Assumptions to Verify](#appendix-c--model-reference-and-assumptions-to-verify)

---

## 1. Product Summary

Round Table is a local-first web application where eight AI agents sit around a virtual round table and collaboratively generate, debate, and vote on project ideas. Seven agents each carry a distinct evaluative lens. The eighth is the **Me Agent**, built from the user's real GitHub history, CV, past projects, and hand-written taste notes. The Me Agent holds 25 percent of the voting weight; the seven lens agents split the remaining 75 percent.

The system has two jobs:

- **Demonstration.** The table is watchable in real time. Agents visibly think, speak, attack each other's ideas, and vote. The debate produces genuine emergent behaviour rather than independent parallel answers.
- **Utility.** The winning idea is grounded in the user's actual skill level, stack preferences, and history of what they finish, not in generic suggestion text.

The application is local-first: it runs on one machine for one user with no authentication. It is written deploy-ready: every table carries a `user_id`, every secret is read through one config module, and the event bus sits behind an interface. Adding multi-user hosting later is a configuration and adapter change, not a rewrite.

---

## 2. Locked Design Decisions

These were decided during the design interview. Do not re-litigate them during implementation.

| Area | Decision | Rationale |
|---|---|---|
| Runtime shape | Local single-user, deploy-ready | Fastest to build, no auth surface, but no schema or config rewrite needed to host later |
| Framework | Next.js (App Router) + TypeScript | One deploy unit, one language, Route Handlers give streaming responses for free |
| Database | SQLite via Drizzle ORM | Zero setup, single file, inspectable with any SQLite browser, typed schema |
| LLM providers | DeepSeek and GLM, split across the seats | Both are OpenAI-compatible, so one adapter serves both |
| Transport | Server-Sent Events for server to client, plain POST for control | All live traffic is one-way; control actions are discrete and idempotent |
| Stop button | Pause and resume | Keeps completed work, resumes from the next pending task, no wasted tokens |
| Web search | Tavily API, real calls, for the Trend-Watcher only | Live landscape input; interface is abstracted so the provider can be swapped |
| Agent customisation | All eight seats editable in the UI | Prompt tuning is the whole product; it must not require a code change |
| Me Agent inputs | GitHub, CV, local project scan, hand-written taste notes, all editable | Hand editing is required so the user can inject values and correct inference |
| Run history | Browse, token-free replay, export, compare | The debate transcript is the interesting artefact and should outlive the run |
| Testing | Vitest unit tests plus mocked integration | Deterministic verification of math and state machine without burning tokens |
| Concurrency | All agents in a step run in parallel; the UI staggers the reveal | Fast wall clock, choreographed appearance |
| Guardrails | Per-call caps plus a per-run budget abort | A runaway loop must not drain the API balance |
| Scope | All six build steps ship in v1 | Per the original specification |

---

## 3. System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (Next.js client)                                            │
│                                                                      │
│  Run Console  ├─ RoundTable (8 seats)   ├─ ReasoningDrawer           │
│               ├─ StepTimeline           ├─ RevealCard + Dissent      │
│               ├─ Controls               └─ ScoreBreakdown            │
│                                                                      │
│  Pages: /runs  /runs/[id]  /runs/compare  /agents  /profile  /settings│
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ POST control (JSON)              │ GET SSE (event stream)
                ▼                                  ▲
┌──────────────────────────────────────────────────────────────────────┐
│  Next.js server (Node runtime)                                       │
│                                                                      │
│  Route Handlers ──► RunService ──► Orchestrator Engine               │
│                        │                │                            │
│                        │                ├─ Step modules              │
│                        │                │   propose / debate /       │
│                        │                │   refine / vote / reveal   │
│                        │                │                            │
│                        │                ├─ Scheduler (concurrency,   │
│                        │                │   pause flag, retries)     │
│                        │                │                            │
│                        │                ├─ BudgetGuard               │
│                        │                └─ RunEventBus (in-process)  │
│                        │                                             │
│  ProfileService ──► Ingestors (GitHub / CV / local scan / notes)     │
│                        └─ LLM extraction → profile items → summary   │
│                                                                      │
│  LLM Adapter Registry ──► OpenAICompatibleAdapter ─┬─ DeepSeek       │
│                                                    └─ GLM            │
│  Search Adapter ──► TavilyAdapter                                    │
└───────────────┬──────────────────────────────────────────────────────┘
                │ Drizzle ORM
                ▼
        SQLite file  (data/roundtable.db)
```

**Control flow for one run**

1. Client POSTs to `/api/runs` with a seed prompt. The server snapshots the agent configuration into the run row and returns a `runId`.
2. Client opens `GET /api/runs/:id/stream` (SSE) and POSTs `/api/runs/:id/start`.
3. The orchestrator walks the state machine. Each step builds a task list, the scheduler dispatches tasks in parallel, each task streams deltas onto the bus, and the SSE handler forwards them to the browser.
4. The client buffers deltas per agent and releases them on a stagger cadence so avatars light up in sequence.
5. Each step persists its results and emits a completion event. The client advances the step timeline.
6. On REVEAL, a final synthesis call produces the winning detail card, including dissenting opinions gathered from the vote step.

**Read this document with the following module boundaries in mind.** The orchestrator is the only writer to run state. Route handlers never mutate run state directly. The SSE layer is read-only over the event log. The UI never computes scoring; it renders what the server sends.

---

## 4. Technology Stack

### 4.1 Core

| Layer | Choice | Version guidance | Notes |
|---|---|---|---|
| Framework | Next.js, App Router | 15.x or current stable | Node runtime for all route handlers; do not use the Edge runtime, SQLite and long-lived streams need Node |
| Language | TypeScript, `strict: true` | 5.x | No `any` in exported signatures |
| Runtime | Node.js | 20 LTS or newer | Required by `better-sqlite3` and Drizzle |
| Package manager | pnpm | current | Any manager works; lockfile must be committed |

### 4.2 Data

| Layer | Choice | Notes |
|---|---|---|
| Database | SQLite via `better-sqlite3` | Synchronous driver, simplest with Drizzle, fine for single-user local |
| ORM | Drizzle ORM + Drizzle Kit | Schema in TypeScript, migrations generated and committed |
| Validation | Zod | One schema per boundary: API bodies, LLM structured output, config files |

### 4.3 AI and External APIs

| Layer | Choice | Notes |
|---|---|---|
| LLM client | `openai` npm package, used with a custom `baseURL` per provider | Both DeepSeek and GLM expose OpenAI-compatible chat completions with streaming |
| GitHub | `@octokit/rest` plus `@octokit/graphql` | REST for repos and languages, GraphQL for contribution calendar |
| CV parsing | `pdf-parse` for PDF, `mammoth` for DOCX | Markdown and plain text go straight through |
| Web search | Tavily REST API via `fetch` | No SDK required |
| Streaming to browser | Native `ReadableStream` from a Route Handler | Standard SSE framing, no library |

### 4.4 Frontend

| Layer | Choice | Notes |
|---|---|---|
| Styling | Tailwind CSS + CSS custom properties | Tailwind for layout and utilities, custom properties for the theme layer described in section 16.8 |
| Components | shadcn/ui | Copy-in components, no runtime dependency |
| Animation | Framer Motion | Seat states, thought cloud pulse, speech bubble entry, shared-layout expand to the reasoning drawer, reveal card transition |
| Avatar generation | `@dicebear/core` + `@dicebear/collection` | Generates SVG locally, no network call. Deterministic from a seed string. Abstract styles only, per section 16.3 |
| Seat layout | Hand-rolled trigonometry in `src/lib/layout/seats.ts` | No layout library. Eight positions on an ellipse is twenty lines of math, section 16.1 |
| Client data | TanStack Query | Run polling fallback, history list, agent and profile CRUD |
| SSE client | `EventSource` wrapped in a small custom hook | Native API, gives `Last-Event-ID` reconnect for free |
| Icons | lucide-react | Ships with shadcn. Also the alternate avatar style, section 16.3 |
| Thinking animation assets | None in v1 | Pure CSS and Framer keyframes. Lottie is a documented drop-in upgrade, section 16.5 |

### 4.5 Tooling

| Purpose | Choice |
|---|---|
| Unit and integration tests | Vitest |
| Test coverage | `@vitest/coverage-v8` |
| Lint and format | ESLint (`next/core-web-vitals`) + Prettier |
| Type check | `tsc --noEmit` as a CI gate |
| Git hooks | `simple-git-hooks` running lint-staged (optional but recommended) |
| Logging | `pino` with pretty printing in development |

### 4.6 Explicitly out of scope for v1

No authentication. No user accounts beyond a single seeded local user row. No background job queue or worker process; the orchestrator runs in the Next.js server process. No Docker requirement, though the app must run under `next start` without dev-only dependencies. No mobile layout beyond a responsive stack fallback. No voice or avatar images beyond generated SVG or DiceBear.

---

## 5. Repository Layout

```
roundtable/
├─ architecture.md                  # this document
├─ README.md
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json                    # strict: true, paths: @/* -> src/*
├─ next.config.ts
├─ tailwind.config.ts
├─ drizzle.config.ts
├─ vitest.config.ts
├─ .env.example                     # every variable documented, no real values
├─ .env.local                       # gitignored, holds real keys
├─ .gitignore
│
├─ data/                            # gitignored except .gitkeep
│  ├─ roundtable.db                 # SQLite database
│  ├─ uploads/                      # CV files dropped by the user
│  └─ notes/
│     └─ taste.md                   # hand-written taste notes, user-editable on disk
│
├─ drizzle/
│  └─ migrations/                   # generated SQL, committed
│
├─ scripts/
│  ├─ seed.ts                       # seed the local user and the eight default agents
│  ├─ ingest-profile.ts             # CLI: run the profile pipeline without the UI
│  └─ smoke-run.ts                  # CLI: execute a full run headless against the real APIs
│
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx
│  │  ├─ page.tsx                   # redirects to /run
│  │  ├─ globals.css
│  │  ├─ run/page.tsx               # the table (live console)
│  │  ├─ runs/page.tsx              # history list
│  │  ├─ runs/[id]/page.tsx         # read-only replay
│  │  ├─ runs/compare/page.tsx      # two-run comparison
│  │  ├─ agents/page.tsx            # seat editor
│  │  ├─ profile/page.tsx           # Me Agent profile editor
│  │  ├─ settings/page.tsx          # providers, pricing, budgets, search
│  │  └─ api/                       # route handlers, see section 14
│  │
│  ├─ styles/
│  │  ├─ themes.css                 # both theme token sets, section 16.8
│  │  └─ motion.css                 # shared keyframes that are cheaper in CSS than in Framer
│  │
│  ├─ components/
│  │  ├─ table/  RoundTable.tsx  Seat.tsx  SeatAura.tsx  ThoughtCloud.tsx
│  │  │          Avatar.tsx  TableSurface.tsx  SeatStack.tsx  CenterPlinth.tsx
│  │  │          SpeechBubble.tsx
│  │  ├─ run/    Controls.tsx  StepTimeline.tsx  RevealCard.tsx
│  │  │          DissentList.tsx  ScoreBreakdown.tsx  ReasoningDrawer.tsx
│  │  ├─ history/ RunHistoryList.tsx  RunCompare.tsx
│  │  ├─ profile/ ProfileItemTable.tsx  ProfileIngestPanel.tsx  ProfileSummaryPreview.tsx
│  │  ├─ agents/  SeatForm.tsx  SeatGrid.tsx  WeightPreview.tsx
│  │  └─ ui/      shadcn generated primitives
│  │
│  ├─ hooks/
│  │  ├─ useRunStream.ts            # EventSource + reducer + stagger queue
│  │  ├─ useStaggerQueue.ts         # release buffered deltas on a cadence
│  │  ├─ useTheme.ts                # theme token switch, section 16.8
│  │  └─ useRunPolling.ts           # fallback when SSE is unavailable
│  │
│  ├─ lib/
│  │  ├─ layout/
│  │  │  └─ seats.ts                # ellipse placement math, section 16.1
│  │  ├─ db/
│  │  │  ├─ client.ts               # better-sqlite3 + Drizzle instance
│  │  │  ├─ schema.ts               # all tables, see section 7
│  │  │  └─ queries/                # typed query helpers per table
│  │  ├─ llm/
│  │  │  ├─ types.ts                # LLMAdapter, AgentCallRequest, LLMDelta
│  │  │  ├─ openai-compatible.ts    # the one adapter implementation
│  │  │  ├─ registry.ts             # provider key + model id -> adapter instance
│  │  │  ├─ mock.ts                 # scripted adapter for tests
│  │  │  ├─ pricing.ts              # token price table, cost estimation
│  │  │  └─ json.ts                 # structured output parse, repair, retry
│  │  ├─ search/
│  │  │  ├─ types.ts                # SearchAdapter interface
│  │  │  ├─ tavily.ts
│  │  │  └─ stub.ts                 # canned results for offline development
│  │  ├─ orchestrator/
│  │  │  ├─ engine.ts               # run loop and state machine driver
│  │  │  ├─ scheduler.ts            # concurrency pool, pause flag, retry policy
│  │  │  ├─ bus.ts                  # RunEventBus interface + InMemoryRunEventBus
│  │  │  ├─ budget.ts               # BudgetGuard
│  │  │  ├─ context.ts              # builds the prompt context for each step
│  │  │  ├─ digest.ts               # compresses prior artefacts for later steps
│  │  │  ├─ taskKey.ts              # idempotency keys
│  │  │  └─ steps/
│  │  │     ├─ propose.ts
│  │  │     ├─ debate.ts
│  │  │     ├─ refine.ts
│  │  │     ├─ vote.ts
│  │  │     └─ reveal.ts
│  │  ├─ agents/
│  │  │  ├─ defaults.ts             # the eight seeded seats
│  │  │  └─ weights.ts              # normalisation and tie-break rules
│  │  ├─ profile/
│  │  │  ├─ github.ts               # Octokit ingestion
│  │  │  ├─ cv.ts                   # pdf/docx/markdown ingestion
│  │  │  ├─ localScan.ts            # local project folder scan
│  │  │  ├─ notes.ts                # taste notes file
│  │  │  ├─ extract.ts              # LLM extraction of structured items
│  │  │  ├─ merge.ts                # merge with locked items preserved
│  │  │  └─ summary.ts              # deterministic summary rendering
│  │  ├─ export/
│  │  │  ├─ markdown.ts
│  │  │  └─ json.ts
│  │  ├─ config.ts                  # env reading, one module, server-only
│  │  └─ logger.ts
│  │
│  ├─ shared/
│  │  ├─ types.ts                   # DTOs shared by server and client
│  │  ├─ events.ts                  # SSE event type union
│  │  └─ constants.ts               # step names, statuses, defaults
│  │
│  └─ test/
│     ├─ fixtures/                  # golden run, sample CV text, sample GitHub payload
│     ├─ unit/                      # weights, state machine, budget, json, digest
│     └─ integration/               # full run against MockLLMAdapter
```

---

## 6. Configuration and Secrets

All environment access goes through `src/lib/config.ts`. **MUST**: no other file reads `process.env`. The module is server-only (`import 'server-only'` at the top) so a key can never be bundled into client JavaScript.

### 6.1 Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | yes | — | DeepSeek key |
| `DEEPSEEK_BASE_URL` | no | `https://api.deepseek.com/v1` | Override for proxies |
| `GLM_API_KEY` | yes | — | Zhipu GLM key |
| `GLM_BASE_URL` | no | `https://open.bigmodel.cn/api/paas/v4` | Override for proxies |
| `TAVILY_API_KEY` | yes for live search | — | Trend-Watcher search |
| `GITHUB_TOKEN` | recommended | — | Fine-grained PAT, read-only public and private repo scope. Without it GitHub rate limits to 60 requests per hour |
| `GITHUB_USERNAME` | yes for ingestion | — | Account to analyse |
| `DATABASE_URL` | no | `file:./data/roundtable.db` | SQLite path |
| `APP_USER_ID` | no | `local-user` | The single seeded user id |
| `SEARCH_PROVIDER` | no | `tavily` | `tavily` or `stub` |
| `RUN_BUDGET_USD` | no | `1.00` | Hard per-run cost ceiling |
| `RUN_MAX_TOKENS` | no | `250000` | Hard per-run token ceiling |
| `RUN_MAX_CALLS` | no | `60` | Hard per-run LLM call ceiling |
| `LOG_LEVEL` | no | `info` | pino level |
| `MOCK_LLM` | no | `false` | Force the mock adapter for every seat, for offline development |

### 6.2 Non-secret runtime settings

Stored in the `settings` table and edited on `/settings`: active theme (`warroom` or `hearth`, section 16.8), default budget values, token prices per model, stagger cadence in milliseconds, refine step enabled, maximum critiques per agent, reasoning panel enabled, default avatar style, and default temperature per seat class. Secrets never enter the database. The settings page shows only whether a key is present, read from config at request time, never the value.

### 6.3 Deploy-ready note

For a hosted version, replace `src/lib/config.ts` with a per-user secret lookup keyed by `user_id`, and swap `InMemoryRunEventBus` for a Redis pub/sub implementation of the same interface. No other module changes.

---

## 7. Data Model

SQLite, Drizzle ORM. All tables carry `user_id` where the row is user-scoped, even though v1 has one user. All timestamps are integer Unix milliseconds. All ids are text UUID v4 generated in application code with `crypto.randomUUID()`. Every table has `created_at`; mutable tables also have `updated_at`.

### 7.1 `users`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `APP_USER_ID`, seeded once |
| `display_name` | text | Shown as the Me Agent seat label |
| `created_at` | integer | |

### 7.2 `profiles`

One row per profile version. Exactly one row per user is active.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `user_id` | text FK | |
| `version` | integer | Increments on each regeneration |
| `status` | text | `draft` \| `active` \| `archived` |
| `summary_text` | text | Rendered Markdown summary injected into prompts |
| `author_brief` | text | Shorter summary given to the seven lens agents |
| `source_hash` | text | SHA-256 over the raw inputs, used to detect staleness |
| `generated_at` | integer | |
| `last_manual_edit_at` | integer | Null when never hand-edited |

### 7.3 `profile_items`

The atomic, individually editable units of the profile. This table is what the `/profile` editor reads and writes.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `profile_id` | text FK | |
| `kind` | text | `skill` \| `project` \| `taste` \| `experience` \| `constraint` \| `goal` \| `anti_pattern` |
| `label` | text | Short name, for example `TypeScript` or `Abandoned side projects` |
| `detail` | text | One to three sentences of supporting detail |
| `source` | text | `github` \| `cv` \| `local_scan` \| `notes` \| `inferred` \| `manual` |
| `confidence` | real | 0 to 1. Manual items are always 1.0 |
| `locked` | integer | Boolean. Locked items survive regeneration untouched |
| `order_index` | integer | Display order within kind |
| `created_at` / `updated_at` | integer | |

**Requirement:** every item exposes provenance in the UI. An item with `source = 'inferred'` renders with a distinct marker and an "edit" affordance, so the user can correct the machine's guess in one click. This is a core product requirement, not a nicety.

### 7.4 `agents`

One row per seat. Seeded with the eight defaults, fully editable afterwards.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | Stable id, for example `seat_me`, `seat_pragmatist` |
| `user_id` | text FK | |
| `seat_key` | text unique per user | Machine key |
| `name` | text | Display name, editable |
| `is_me_agent` | integer | Boolean. Exactly one row may be true |
| `lens_prompt` | text | The seat's evaluative lens. Editable |
| `provider` | text | `deepseek` \| `glm` \| `mock` |
| `model_id` | text | For example `deepseek-chat` |
| `temperature` | real | Per-seat |
| `weight` | real | Raw weight, normalised at vote time |
| `avatar_style` | text | `dicebear` \| `lucide` \| `initials`. Default `dicebear`. Section 16.3 |
| `avatar_seed` | text | Seed string for deterministic generation. Defaults to `seat_key` |
| `avatar_svg_cache` | text nullable | Generated SVG markup, written once. Null means generate on read |
| `accent_color` | text | Hex seat colour. Defaults from the palette in section 16.4, editable |
| `accent_token` | text | Theme token name, for example `--seat-4`, so accents follow the active theme rather than a hardcoded hex |
| `enabled` | integer | Boolean. Disabled seats are skipped, weights re-normalise |
| `order_index` | integer | Seat position around the table |
| `created_at` / `updated_at` | integer | |

### 7.5 `runs`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `user_id` | text FK | |
| `seed_prompt` | text | Raw input |
| `seed_mode` | text | `vague` \| `specific` |
| `status` | text | `created` \| `running` \| `paused` \| `completed` \| `failed` \| `aborted` |
| `current_step` | text | `propose` \| `debate` \| `refine` \| `vote` \| `reveal` \| `done` |
| `step_index` | integer | For progress display |
| `round` | integer | Debate and refine round counter, starts at 1 |
| `profile_id` | text FK | The profile version used |
| `agent_snapshot` | text JSON | Full agent config frozen at run start |
| `config_snapshot` | text JSON | Budgets, stagger cadence, refine enabled, search enabled |
| `tokens_in` / `tokens_out` | integer | Running totals |
| `cost_estimate_usd` | real | Running estimate from the price table |
| `llm_calls` | integer | Running count |
| `pause_requested` | integer | Boolean flag, see section 11.4 |
| `error_code` | text | Null unless failed |
| `error_message` | text | Null unless failed |
| `started_at` / `completed_at` | integer | |
| `created_at` | integer | |

**MUST:** `agent_snapshot` freezes provider, model, weight, temperature, and lens prompt at run start. Editing a seat later must never alter a completed or in-flight run's arithmetic or replay output.

### 7.6 `proposals`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `run_id` | text FK | |
| `agent_id` | text FK | |
| `round` | integer | 1 for propose, 2 for refined |
| `title` | text | Short, under 80 characters |
| `description` | text | Two to four sentences |
| `rationale` | text | Why this seat's lens favours it |
| `parent_proposal_id` | text nullable | Set when this proposal is a refinement or merge |
| `status` | text | `active` \| `merged` \| `eliminated` |
| `created_at` | integer | |

### 7.7 `critiques`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `run_id` | text FK | |
| `agent_id` | text FK | Author of the critique |
| `target_proposal_id` | text FK | |
| `stance` | text | `support` \| `attack` \| `extend` |
| `comment` | text | One to three sentences |
| `round` | integer | |
| `created_at` | integer | |

### 7.8 `votes`

One row per agent per scored proposal.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `run_id` | text FK | |
| `agent_id` | text FK | |
| `proposal_id` | text FK | |
| `score` | integer | 1 to 10 |
| `weight_at_vote` | real | Normalised weight copied at vote time |
| `weighted_score` | real | `score × weight_at_vote` |
| `comment` | text | One sentence justification, shown in dissent lists |
| `created_at` | integer | |

### 7.9 `run_events`

The append-only event log. This is the backbone of SSE reconnect and token-free replay.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | Doubles as the SSE `Last-Event-ID` |
| `run_id` | text FK | |
| `seq` | integer | Per-run monotonic sequence |
| `type` | text | See section 13.3 |
| `agent_id` | text nullable | |
| `step` | text nullable | |
| `payload` | text JSON | Event-specific body |
| `created_at` | integer | |

Index on `(run_id, seq)`.

### 7.10 `agent_messages`

The full per-call transcript. Powers the reasoning drawer and replay. Never sent wholesale into later prompts; that is what the digest step is for.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `run_id` | text FK | |
| `agent_id` | text FK | |
| `step` | text | |
| `task_key` | text | Unique idempotency key, see section 17.4 |
| `request_json` | text JSON | Messages, params, model. Redact nothing; keys are never in this payload |
| `reasoning_text` | text | Accumulated reasoning-channel text where the model exposes it |
| `content_text` | text | Accumulated answer text |
| `tokens_in` / `tokens_out` | integer | |
| `cost_usd` | real | |
| `latency_ms` | integer | |
| `finish_reason` | text | |
| `error` | text nullable | |
| `created_at` | integer | |

Unique index on `task_key`.

### 7.11 `settings`

Key-value table: `key` text PK, `value` text JSON, `updated_at` integer. Holds the non-secret settings listed in section 6.2.

### 7.12 `model_pricing`

| Column | Type | Notes |
|---|---|---|
| `provider` | text | |
| `model_id` | text | |
| `input_per_mtok_usd` | real | |
| `output_per_mtok_usd` | real | |
| `updated_at` | integer | |

Seeded by `scripts/seed.ts` with the figures from Appendix C. Used only for the cost estimate and the budget guard.

**Composite primary key** on `(provider, model_id)`.

### 7.13 Entity relationships

```
users 1─n profiles 1─n profile_items
users 1─n agents
users 1─n runs
runs  1─n proposals 1─n critiques (target)
runs  1─n proposals 1─n votes
runs  1─n run_events
runs  1─n agent_messages
runs  n─1 profiles
```

Enable `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL` on connection open.

---

## 8. Provider Adapter Layer

### 8.1 Interface

Every model call in the system goes through this interface. No step module imports a vendor SDK.

```ts
export type DeltaKind = 'reasoning' | 'text';

export interface LLMDelta {
  kind: DeltaKind;
  text: string;
}

export interface AgentCallRequest {
  provider: 'deepseek' | 'glm' | 'mock';
  modelId: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  maxTokens: number;
  /** Ask the provider for a JSON object response where it supports the parameter. */
  jsonMode?: boolean;
  /** Enable the reasoning channel where the model exposes one. */
  reasoning?: boolean;
}

export interface AgentCallResult {
  reasoningText: string;
  contentText: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
  latencyMs: number;
}

export interface LLMAdapter {
  stream(req: AgentCallRequest, signal: AbortSignal): AsyncIterable<LLMDelta>;
  complete(req: AgentCallRequest, signal: AbortSignal): Promise<AgentCallResult>;
}
```

`complete` is implemented as `stream` plus accumulation, so there is exactly one place that touches the wire.

### 8.2 The single implementation

`OpenAICompatibleAdapter` is constructed with a base URL and an API key. It is the only adapter that talks to a network. Both providers use it:

| Provider | Base URL | Auth |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `Authorization: Bearer <DEEPSEEK_API_KEY>` |
| `glm` | `https://open.bigmodel.cn/api/paas/v4` | `Authorization: Bearer <GLM_API_KEY>` |

`registry.ts` maps a provider key to a memoised adapter instance. It throws a typed `MissingProviderKeyError` at call time, not at import time, so the app boots without keys and fails only on an actual generation attempt.

### 8.3 Provider quirks that MUST be handled

These are the differences that break naive OpenAI-compatible code. Handle each explicitly and cover each with a unit test using a recorded fixture.

1. **Reasoning channels have different field names.** DeepSeek reasoning models emit `delta.reasoning_content` alongside or instead of `delta.content`. GLM emits a thinking block in a provider-specific field. The adapter **MUST** normalise both into `LLMDelta { kind: 'reasoning' }` and `{ kind: 'text' }`. If a provider's reasoning field is absent, the adapter emits no reasoning deltas and the UI simply shows no reasoning for that seat.
2. **Usage on stream requires an option.** Streaming responses do not always include a usage block. The adapter **MUST** request stream usage where supported and fall back to a local token estimate (characters divided by four, rounded up) so the budget guard always has a number.
3. **JSON mode is not universal.** The adapter **MUST** treat `jsonMode` as a hint. Actual enforcement happens in `lib/llm/json.ts`, which extracts the first balanced JSON object from the text, validates it with Zod, and on failure performs exactly one repair retry with a shortened corrective message. Two consecutive failures raise `StructuredOutputError`, which the scheduler records against the task.
4. **Rate limits and transient errors.** HTTP 429 and 5xx are retried by the scheduler, not the adapter. The adapter **MUST** classify errors into `{ retryable: true | false }` and surface that on a typed error. 4xx other than 429 is not retryable.
5. **Time to first token differs.** DeepSeek reasoning models can think for many seconds before emitting the first content token. The UI **MUST NOT** treat a silent stream as stalled before the per-call timeout. Reasoning deltas, when present, solve this naturally.

### 8.4 Model assignment

Locked default assignment, editable per seat on `/agents`:

| Seat | Provider | Model | Reasoning |
|---|---|---|---|
| Me Agent | deepseek | `deepseek-reasoner` | enabled |
| The Pragmatist | deepseek | `deepseek-chat` | off |
| The Technical Architect | deepseek | `deepseek-chat` | off |
| The Contrarian | deepseek | `deepseek-chat` | off |
| The Wildcard | glm | `glm-4.6` | off |
| The Mentor | glm | `glm-4.6` | off |
| The Market Analyst | glm | `glm-4.6` | off |
| The Trend-Watcher | glm | `glm-4.6` | off |
| Reveal synthesis | deepseek | `deepseek-reasoner` | enabled |

Verify the exact model identifiers against each provider's current documentation before first run; see Appendix C.

---

## 9. Agent Definitions and Prompts

### 9.1 Prompt structure

Every agent call is assembled in four layers, in this order, as separate messages:

1. **System contract.** Fixed, shared by all seats. Defines the output format, the JSON schema for the current step, the ban on meta-commentary, and the length limits. Never contains a persona.
2. **Seat lens.** The seat's `lens_prompt` from the `agents` table. This is what the user edits.
3. **Author snapshot.** The short profile brief. Injected into **every** seat, not just the Me Agent, so no lens proposes work the user cannot or will not do.
4. **Step context.** The seed prompt, the step's task, and the digests of prior step artefacts.

The system contract is a code constant. The lens is data. This split is what makes the seat editor safe: users edit step 2 and can never corrupt step 1.

### 9.2 The eight seats

The seven lens agents are seeded from `lib/agents/defaults.ts`. Full prompt text is in Appendix B. Summary of the evaluative lens and the failure mode it exists to prevent:

| Seat | Lens | Prevents |
|---|---|---|
| The Pragmatist | What ships in two weeks with the tools already available | Grand plans that never reach a first commit |
| The Wildcard | Deliberately anti-obvious; rewards novelty and weirdness | Regression to safe, boring suggestions |
| The Market Analyst | Usefulness, demand, willingness to pay | Clever projects nobody would ever use |
| The Technical Architect | Elegance, learning value, structural quality | Projects that teach nothing and produce a mess |
| The Contrarian | Attacks every proposal, including the current front-runner | Groupthink and premature consensus |
| The Mentor | Scope realism, abandonment risk, energy cost | The user's own known pattern of abandoned work |
| The Trend-Watcher | Current landscape from live search results | Ideas already saturated or already shipped by someone else |

**The Me Agent** is seeded with `is_me_agent = true` and gets two extra blocks: the full profile summary in place of the short brief, and an explicit instruction to propose only work it will actually finish, citing the profile's `anti_pattern` and `constraint` items where relevant.

### 9.3 Prompt requirements

- Every seat **MUST** receive the same step instruction and the same output schema. Only the lens differs. Divergence between seats must come from the lens, never from format drift.
- **MUST** state a hard length limit in the system contract per step and enforce the matching `maxTokens` in the request. Length limits: propose 220 words per idea, critique 90 words per critique, vote comment one sentence, refine 220 words.
- **MUST** forbid the agent from mentioning that it is an AI, from addressing the user directly, and from narrating its own process.
- **MUST** include the phrase "Do not repeat an idea already present in the discussion" in propose and refine, to reduce duplicate proposals.
- The Contrarian's lens **MUST** instruct it to attack the strongest proposal, not the weakest, and to state what evidence would change its mind.

---

## 10. Me Agent Profile Pipeline

This is the part that separates the product from a generic idea generator, so it gets its own service and its own editor.

### 10.1 Sources

| Source | Module | Input | Extraction |
|---|---|---|---|
| GitHub | `profile/github.ts` | REST: repos, languages, topics, README excerpt. GraphQL: contribution calendar | Deterministic signals first, then one LLM pass to summarise |
| CV or resume | `profile/cv.ts` | PDF, DOCX, Markdown, or plain text in `data/uploads/` | LLM pass to structured items |
| Local projects | `profile/localScan.ts` | A list of local folder paths, configured on `/profile` | Read manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`) to detect stacks. LLM pass only to summarise intent |
| Taste notes | `profile/notes.ts` | `data/notes/taste.md`, editable on disk or in the UI | Passed through largely verbatim, then chunked into items |
| Hand-written | editor UI | Direct entry | Never touched by generation |

### 10.2 GitHub signals computed

`github.ts` **MUST** compute and store these as profile items or as summary facts:

- Top five languages by bytes across non-fork repos.
- Count of repositories with at least one commit in the last 90 days: the "shipped" signal.
- Count of repositories with a description, at least five commits, and no commit in the last twelve months: the "abandoned" signal. This is the most valuable single input to the Mentor seat.
- Median repository age and median commit count, as a rough project-size preference.
- Topics and README first lines, used to characterise domain interest.
- Total stars and the highest-starred repository, as a signal of what the user values publicly.
- Contribution calendar heatmap density over the last year, as a signal of current cadence.

Fetch with pagination, cap at 300 repositories, and cache the raw response payload under `data/cache/github.json` with a timestamp so the pipeline can re-run without hitting the API.

### 10.3 Extraction to items

One LLM call per source, temperature 0.2, `jsonMode: true`, producing an array of items matching the `profile_items` schema. Requirements:

- Every emitted item **MUST** be assigned a `source` matching the ingestor it came from.
- Inferred items (taste, anti-patterns) get `source = 'inferred'` and `confidence` below 0.8. The extraction prompt **MUST** instruct the model to be conservative and to emit nothing rather than speculate.
- The prompt **MUST** cap output at 12 items per source to keep the profile readable.

### 10.4 Merge rule

`merge.ts` combines a fresh extraction with the existing profile:

1. Items with `source = 'manual'` or `locked = 1` are copied through untouched. **This is the guarantee that makes regeneration safe.**
2. Generated items are matched against existing generated items by `kind` plus a normalised label. Matching items are updated in place, preserving `order_index`.
3. Unmatched generated items are inserted; generated items absent from the new extraction are marked stale and hidden by default, with a "show removed" toggle so nothing disappears silently.
4. The result becomes a new `profiles` row at `version + 1`, and the old row becomes `archived`. The user activates a version explicitly.

### 10.5 Summary rendering

`summary.ts` renders two prompts from the active profile, deterministically, with no LLM call. Template plus items, so the same profile always produces the same text and the user can see exactly what the agents receive.

- `summary_text` for the Me Agent: every `kind`, full detail, ordered by kind then `order_index`.
- `author_brief` for the seven lens agents: `skill`, `constraint`, `anti_pattern`, and `goal` items only, labels with one-line details, hard-capped at 400 words.

Both are stored on the `profiles` row at generation time and refreshed on any manual edit of an item.

### 10.6 Editor requirements

Route `/profile`. Requirements:

- Table of items grouped by `kind`, each row editable inline. Add, delete, reorder within kind.
- A lock toggle per item. Locked items never change on regeneration.
- A provenance badge per item showing `source`, with inferred items visually marked as guesses.
- A `Regenerate from sources` button that runs the pipeline, shows a diff preview (added, changed, removed), and requires confirmation before writing a new version.
- A live preview pane showing the exact `summary_text` and `author_brief` that agents will receive.
- A `Test this profile` action that runs a single Me Agent proposal call against the current unsaved draft so the user can see the effect immediately.
- Ingestion runs are recorded with timestamp, source, item counts, and any error, displayed as a history list so a failed GitHub fetch is visible rather than silent.

---

## 11. Orchestration State Machine

### 11.1 Run status

```
created ──start──► running ──┬── all steps done ──► completed
                             ├── pause requested ─► paused ──resume──► running
                             ├── budget or fatal ─► failed
                             └── abort ───────────► aborted
paused ──abort──► aborted
```

### 11.2 Steps

```
propose ──► debate ──► refine ──► vote ──► reveal ──► done
```

`refine` is skipped when the run config sets `refineEnabled: false` or when no proposal received a critique.

### 11.3 Step definitions

Each step module exports two functions, and the engine owns all persistence:

```ts
export interface StepTask {
  agentId: string;
  taskKey: string;
  buildRequest(ctx: RunContext): AgentCallRequest;
  applyResult(ctx: RunContext, result: StepResult): Promise<void>;
  onDelta(delta: LLMDelta): void;
}

export interface StepModule {
  name: StepName;
  buildTasks(ctx: RunContext): StepTask[];
  onStepComplete(ctx: RunContext): Promise<void>;
  isComplete(ctx: RunContext): boolean;
}
```

| Step | Tasks | Each task produces | Applies to |
|---|---|---|---|
| **propose** | 1 per enabled seat | 1 or 2 ideas with title, description, rationale | `proposals` with `round = 1` |
| **debate** | 1 per enabled seat | 2 or 3 critiques, each with a target proposal id, a stance, and a comment | `critiques` |
| **refine** | 1 per seat whose proposal drew a critique, capped at 4 seats, plus any seat that chooses to merge | 0 or 1 revised or merged proposal | new `proposals` with `round = 2`, `parent_proposal_id` set, parent marked `merged` where applicable |
| **vote** | 1 per enabled seat | One score from 1 to 10 per surviving proposal, with a one-sentence comment | `votes` rows, one per proposal per seat |
| **reveal** | 1 total, non-agent | Synthesis of the winner plus dissent | `runs` completion fields, event payload |

**Token-control requirement.** Vote and debate **MUST** be one call per agent covering all targets, not one call per target. A naive per-target fan-out turns 8 agents times 5 proposals into 40 calls and blows the budget for no quality gain. Only `refine` fans out per proposal, and it is capped.

### 11.4 Pause and resume semantics

The Stop button pauses. The semantics are precise and **MUST** be implemented exactly:

1. `POST /api/runs/:id/pause` sets `runs.pause_requested = 1` and returns immediately. It does not cancel anything.
2. The scheduler checks `pause_requested` before dispatching each task. In-flight calls are never aborted; they run to completion, stream, and persist normally. The user asked for no messy mid-generation interruption, and a half-finished critique is worse than a slow stop.
3. When the scheduler finds the flag set and no tasks are in flight, the engine writes partial step results, sets `status = 'paused'`, and emits `run.paused` with the pending task keys so the UI can show exactly what remains.
4. `POST /api/runs/:id/resume` clears the flag and re-enters the same step. `buildTasks` runs again, and the scheduler **MUST** filter out tasks whose `task_key` already exists in `agent_messages`. This is what makes resume idempotent and prevents paying twice for completed work.
5. A paused run can be aborted, which sets `status = 'aborted'` and keeps all partial data for inspection.

### 11.5 Engine loop

```
async function runLoop(runId) {
  while (status is running) {
    const step = steps[currentStep]
    const tasks = await step.buildTasks(ctx)
    const pending = tasks.filter(t => !taskExists(t.taskKey))
    await scheduler.run(pending)          // concurrency pool, retries, budget checks
    if (pauseRequested) { setStatus('paused'); emit('run.paused'); return }
    await step.onStepComplete(ctx)        // persistence, digest building
    emit('step.completed')
    currentStep = nextStep(currentStep)   // skipping refine when configured
  }
  emit('run.completed')
}
```

### 11.6 Idempotency keys

Format: `run:{runId}:step:{step}:agent:{agentId}:round:{round}:attempt-agnostic`. Retries reuse the same key; only the first successful write persists. The unique index on `agent_messages.task_key` enforces this at the database level, so a crashed and restarted server cannot double-charge a call.

---

## 12. Scoring and Voting Math

### 12.1 Normalisation

Weights are stored raw and normalised once per run, at vote time, over the **enabled** seats only.

```
W = Σ weight(agent) for enabled agents
normalisedWeight(agent) = weight(agent) / W
```

Defaults: Me Agent `0.25`, each of the seven lens agents `0.75 / 7 ≈ 0.107142857`.

Because normalisation happens over enabled seats, disabling a seat or adding a new one rebalances automatically with no manual weight editing. The `/agents` page **MUST** show a live normalised-weight preview so the user sees the effective percentages while editing.

### 12.2 Final score

```
final_score(proposal) = Σ over enabled agents ( vote.score × normalisedWeight(agent) )
```

Scores are 1 to 10 integers. `weighted_score` is stored per vote row for display; the aggregate is recomputed from stored rows rather than cached, so a display bug cannot corrupt the result.

Normalised weights and raw weights are both frozen into `agent_snapshot` at run start and copied to every `votes` row as `weight_at_vote`. This makes a completed run's arithmetic reproducible forever, even if the seats are edited afterwards.

### 12.3 Tie-break

Strictly ordered, first rule that breaks the tie wins:

1. Higher weighted score for the Me Agent alone.
2. Higher unweighted mean score across all enabled seats.
3. Higher score from the Contrarian, on the theory that surviving the harshest seat is a real signal.
4. Lower `created_at` on the proposal, so the earlier idea wins.
5. Deterministic final fallback: lexicographic order of `proposal.id`.

Rule 5 guarantees the function is total. A test **MUST** cover the fully tied case.

### 12.4 Dissent collection

An agent is a dissenter on a proposal when its `score` is at or below `mean(scores) - 2` for that proposal, or when it scored the winning proposal below 5. Dissent rows surface on the reveal card with the seat name, colour, score, and comment. Dissent is a first-class output, not an afterthought: the spec calls it the most interesting part and the product should treat it that way.

### 12.5 Derived run metrics

Computed at completion and stored in the reveal event payload for the history and compare views:

| Metric | Definition |
|---|---|
| `winner_score` | Final weighted score of the winning idea |
| `score_spread` | Highest minus lowest final score among active proposals, a consensus measure |
| `me_alignment` | Whether the winner was also the Me Agent's top-scored proposal |
| `dissent_count` | Number of dissent rows |
| `distinctness` | Mean pairwise Jaccard similarity over proposal title plus description token sets, an idea-diversity measure |
| `total_cost_usd` | Sum of call costs |

---

## 13. Streaming and Event Bus

### 13.1 Bus interface

```ts
export interface RunEvent {
  seq: number;
  runId: string;
  type: RunEventType;
  agentId?: string;
  step?: StepName;
  payload: unknown;
  createdAt: number;
}

export interface RunEventBus {
  publish(event: Omit<RunEvent, 'seq'>): Promise<RunEvent>;
  subscribe(runId: string, onEvent: (e: RunEvent) => void): () => void;
  replay(runId: string, afterSeq: number): Promise<RunEvent[]>;
}
```

`InMemoryRunEventBus` is a single-process implementation backed by an `EventEmitter` for live delivery and the `run_events` table for durability and replay. It satisfies both the streaming and the replay requirement with one code path. A hosted deployment swaps in a Redis implementation of the same interface.

### 13.2 Delta throttling

Token deltas are frequent and small. The bus **MUST** coalesce text deltas before publishing: accumulate for 40 milliseconds or 40 characters, whichever comes first, then publish one `agent.delta` event. Reasoning deltas publish on the same cadence into a separate channel. This keeps the database write volume and the SSE frame count sane without making the stream feel chunky.

Deltas **MUST** be persisted to `agent_messages` only at task completion, never per token. `run_events` keeps a compact record: `agent.status` transitions, and for replay purposes the final text, not every token.

### 13.3 Event types

| Type | Payload | Client effect |
|---|---|---|
| `run.started` | `{ steps: string[] }` | Initialise timeline |
| `step.started` | `{ step, round }` | Highlight the timeline node |
| `agent.status` | `{ status: 'thinking' \| 'idle' \| 'spoken' }` | Drive the avatar animation |
| `agent.delta` | `{ kind: 'reasoning' \| 'text', text }` | Feed the stagger queue and the reasoning drawer |
| `agent.done` | `{ finalText, tokensIn, tokensOut, costUsd, latencyMs }` | Set the speech bubble text, stop the thought cloud |
| `agent.failed` | `{ code, message, retryable }` | Mark the seat with an error pose, keep the run alive |
| `step.completed` | `{ step, summary }` | Advance the timeline, apply the step's artefacts |
| `budget.warning` | `{ usedUsd, limitUsd, pct }` | Show a warning banner at 80 percent |
| `run.paused` | `{ pendingTaskKeys, nextStep }` | Switch controls to Resume |
| `run.resumed` | `{ step }` | Switch controls back to Stop |
| `run.completed` | `{ winner, metrics }` | Open the reveal card |
| `run.failed` | `{ code, message }` | Error state with the reason |
| `run.aborted` | `{ atStep }` | Terminal state, data preserved |

### 13.4 SSE endpoint behaviour

- Content type `text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, and `X-Accel-Buffering: no`.
- Event id is the `run_events.id`; the client's `EventSource` sends `Last-Event-ID` automatically on reconnect. On connect, the handler replays events after that id, so a dropped connection resumes mid-run without the client tracking anything.
- A `:heartbeat` comment every 15 seconds keeps proxies and the browser from closing an idle connection during a long reasoning call.
- The handler runs until the run reaches a terminal status, then emits a final event and closes. The client **MUST** treat a close without a terminal event as a transport failure and fall back to polling `GET /api/runs/:id` once before deciding to reconnect.

---

## 14. HTTP API Contracts

All handlers validate their body with Zod, return typed JSON, and never leak stack traces. Errors use `{ error: { code, message } }` with an appropriate status.

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| `POST` | `/api/runs` | `{ seedPrompt, seedMode?, refineEnabled?, budgetUsd? }` | `201 { runId, status }` | Creates the run, snapshots agents, does not start |
| `POST` | `/api/runs/:id/start` | — | `202 { status }` | Begins the loop. Idempotent: starting a running run is a no-op |
| `POST` | `/api/runs/:id/pause` | — | `202 { status }` | Sets the pause flag |
| `POST` | `/api/runs/:id/resume` | — | `202 { status }` | Clears the flag, re-enters the step |
| `POST` | `/api/runs/:id/abort` | — | `200 { status }` | Terminal, keeps data |
| `GET` | `/api/runs/:id/stream` | — | SSE stream | Section 13.4 |
| `GET` | `/api/runs/:id` | — | Full run snapshot | Sections, proposals, critiques, votes, scores, metrics. Polling fallback and replay source |
| `GET` | `/api/runs` | — | `{ runs: RunSummary[] }` | Query params: `limit`, `offset`, `status` |
| `DELETE` | `/api/runs/:id` | — | `204` | Deletes the run and cascades |
| `GET` | `/api/runs/:id/export` | — | File | `?format=md` or `?format=json`, `Content-Disposition: attachment` |
| `GET` | `/api/runs/compare` | — | `{ a, b, deltas }` | Query params `a` and `b` run ids |
| `GET` | `/api/agents` | — | `{ agents, normalisedWeights }` | |
| `PUT` | `/api/agents/:id` | Partial agent | `{ agent }` | Validates weight, model, temperature ranges |
| `POST` | `/api/agents` | New seat | `{ agent }` | Adding seats is allowed; Me Agent flag must stay unique |
| `DELETE` | `/api/agents/:id` | — | `204` | Refuses to delete the Me Agent seat |
| `GET` | `/api/profile` | — | `{ profile, items, ingestRuns }` | Active profile |
| `POST` | `/api/profile/ingest` | `{ source, options? }` | `{ draftId, itemCount, warnings }` | Runs one ingestor, returns a draft, does not activate |
| `POST` | `/api/profile/regenerate` | `{ sources[] }` | `{ diff }` | Full pipeline, returns a diff for confirmation |
| `POST` | `/api/profile/apply` | `{ draftId }` | `{ profile }` | Promotes a draft to active, archives the previous |
| `POST` | `/api/profile/items` | New item | `{ item }` | Manual entry |
| `PUT` | `/api/profile/items/:id` | Partial item | `{ item }` | Editing sets `source = 'manual'` unless the caller passes `keepSource` |
| `DELETE` | `/api/profile/items/:id` | — | `204` | |
| `POST` | `/api/profile/test` | `{ profileDraft? }` | `{ text }` | One Me Agent proposal call against the draft |
| `GET` / `PUT` | `/api/settings` | — | `{ settings, providers }` | Provider block reports presence, never values |
| `GET` | `/api/health` | — | `{ ok, db, providers }` | Provider keys checked for presence only |

**MUST:** every run-mutating handler is safe to call twice. Double-starting, double-pausing, and double-resuming must not corrupt state or duplicate calls.

---

## 15. Frontend Architecture

### 15.1 Routes

| Route | Purpose |
|---|---|
| `/run` | The live table. Default landing page |
| `/runs` | History list with seed prompt, date, status, winner, cost |
| `/runs/[id]` | Read-only replay of a completed run, step by step |
| `/runs/compare` | Two runs side by side with the deltas from section 12.5 |
| `/agents` | Seat editor with live normalised-weight preview |
| `/profile` | Me Agent profile editor |
| `/settings` | Budgets, pricing, search provider, provider key presence |

### 15.2 Client state

One reducer for the live run, fed by the SSE hook, owning: `seats` (status plus buffered and displayed text), `step`, `proposals`, `critiques`, `votes`, `partialScores`, `controls` (`idle | running | paused | done | error`), and `reveal`. TanStack Query owns server data that is not live: history, agents, profile, settings.

**MUST:** the client never computes weighted scores during a live run. It renders the `partial_scores` the server includes in `step.completed` for the vote step. One implementation of the math, in `lib/agents/weights.ts`, used by both server and tests.

### 15.3 Components

| Component | Responsibility |
|---|---|
| `RoundTable` | Ellipse layout via `placeSeats`, distributes run state to seats, owns the `LayoutGroup`. Full spec in section 16.1 |
| `TableSurface` | The inline SVG table. Full spec in section 16.2 |
| `Seat` | Five stacked layers, weight badge always visible, the five visual states. Full spec in sections 16.3 and 16.4 |
| `SeatAura` | The pulsing glow behind a thinking seat. Full spec in section 16.5 |
| `ThoughtCloud` | Anchored cloud with three staggered dots above a thinking seat. Click target for the reasoning drawer |
| `Avatar` | Renders the seat's `avatar_style`: generative SVG, lucide icon, or initials. Full spec in section 16.3 |
| `CenterPlinth` | The table centre: step name, debate tick arc, and the live vote ranking. Full spec in section 16.7 |
| `SpeechBubble` | Two-line maximum take under a spoken seat, entered with a spring |
| `ReasoningDrawer` | Right-side sheet streaming live reasoning, tabs per seat, auto-follow toggle. Renders reasoning channel text when present, otherwise the answer text with a note that this model exposes no separate reasoning |
| `StepTimeline` | Five nodes propose, debate, refine, vote, reveal with live status |
| `Controls` | Generate, Stop, Resume, Abort. Single primary action reflecting run status |
| `RevealCard` | Winner title, description, why it won, score bars per seat, metrics |
| `DissentList` | Dissenting seats with score and comment |
| `ScoreBreakdown` | Stacked bar per proposal by seat colour, from stored `weighted_score` values |
| `ProfileItemTable` | Editable, lockable, provenance-badged profile items |
| `SeatForm` | Seat editing with lens prompt textarea, model picker, temperature, weight slider |
| `WeightPreview` | Live normalised percentages, warns when a seat exceeds 50 percent |

### 15.4 Accessibility and clarity

Keyboard navigation across seats, with Enter opening the reasoning drawer. `aria-live="polite"` region announcing step changes and the winner. Never encode state in colour alone; every seat state carries a text label or icon as well as an animation. Respect `prefers-reduced-motion` by replacing pulse animations with a static thinking indicator.

---

## 16. UI Design Specification — Layout, Avatars, Motion, Theme

This section is the complete visual and interaction specification for the table. It is prescriptive: an implementing agent should be able to build the screen from this section without design decisions of its own. Where a number is given, use that number.

The design goal, stated once so every later choice can be checked against it: **the table must read as a council, not a chat app.** Round seating, one distinct colour per seat, an abstract avatar per persona, and a visible reasoning channel. It should look serious enough to be believed and alive enough to be watched.

### 16.1 Seat layout math

No layout library. Seats are placed with trigonometry on an ellipse in a normalised percentage coordinate space, so the arrangement scales with the container and supports any seat count.

**Why arc-length spacing and not angle spacing.** The naive form `x = cx + r·cos(θ)` with `θ = i·2π/n` spaces seats by angle. On a circle that is correct. On an ellipse, equal angles produce unequal arc distances: the seats bunch at the flat left and right extremes and spread out at the top and bottom. On an 8-seat wide table this is plainly visible. The fix is to space by arc length, which requires solving for the ellipse parameter `t` numerically because the ellipse arc length has no closed form.

`src/lib/layout/seats.ts`:

```ts
export interface SeatPlacement {
  /** Percentage of container width, 0 to 100. */
  x: number;
  /** Percentage of container height, 0 to 100. */
  y: number;
  /** Ellipse parameter in radians. Used to orient the seat's rim highlight. */
  t: number;
}

/** Arc length of the ellipse (a·cos t, b·sin t) from 0 to t, by Simpson's rule. */
function arcLength(a: number, b: number, t: number, steps = 128): number {
  const dt = t / steps;
  const speed = (u: number) => Math.hypot(-a * Math.sin(u), b * Math.cos(u));

  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t0 = i * dt;
    const tm = t0 + dt / 2;
    const t1 = t0 + dt;
    sum += (dt / 6) * (speed(t0) + 4 * speed(tm) + speed(t1));
  }
  return sum;
}

/** Invert arc length: the parameter t at which the arc length equals target. */
function tAtArcLength(a: number, b: number, target: number): number {
  let lo = 0;
  let hi = Math.PI * 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (arcLength(a, b, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Place n seats at equal arc-length spacing around an ellipse.
 * radiusX and radiusY are fractions of the container, 0 to 0.5.
 * Index 0 is the Me Agent, seated at the head of the table, 12 o'clock.
 * Remaining seats proceed clockwise in order_index order.
 */
export function placeSeats(n: number, radiusX: number, radiusY: number): SeatPlacement[] {
  const total = arcLength(radiusX, radiusY, Math.PI * 2);
  const step = total / n;
  const head = total * 0.75; // t = 3π/2 is 12 o'clock when y grows downward

  return Array.from({ length: n }, (_, i) => {
    const target = (head + i * step) % total;
    const t = tAtArcLength(radiusX, radiusY, target);
    return {
      x: 50 + radiusX * 100 * Math.cos(t),
      y: 50 + radiusY * 100 * Math.sin(t),
      t,
    };
  });
}
```

**Defaults and constraints**

| Constant | Value | Notes |
|---|---|---|
| `RADIUS_X` | `0.45` | Fraction of container width. Seats must sit just outside the table rim, not on it |
| `RADIUS_Y` | `0.42` | Fraction of container height |
| Container aspect ratio | `16 / 10` on desktop | `position: relative`, seats absolutely positioned inside |
| Seat diameter | `clamp(52px, 7.2vw, 92px)` | Shrinks before seats collide as the viewport narrows |
| Minimum arc gap | `seatDiameter × 1.35` | If the computed gap falls below this, apply the compact layout from section 16.11 instead of shrinking further |

The layout **MUST** be unit-tested against these properties: seat count matches, all coordinates lie inside 0 to 100, screen-space gap between adjacent seats is uniform within 2 percent, and the Me Agent lands at the top. Arc-length spacing is easy to get subtly wrong and hard to eyeball, so it gets a test rather than a scroll-through.

### 16.2 The table surface

The table is a single inline SVG, no image asset. Layered ellipses produce a convincing surface in either theme: an outer blur for the contact shadow, a gradient rim for the edge bevel, a radial gradient for the surface, an inner light pool from the room, and one engraved ring at the seat radius.

```tsx
// src/components/table/TableSurface.tsx
export function TableSurface({ step }: { step: StepName }) {
  return (
    <svg
      viewBox="0 0 1000 620"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <radialGradient id="surface" cx="50%" cy="40%" r="70%">
          <stop offset="0%"   stopColor="var(--table-core)" />
          <stop offset="70%"  stopColor="var(--table-mid)" />
          <stop offset="100%" stopColor="var(--table-edge)" />
        </radialGradient>
        <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--rim-hi)" stopOpacity="0.50" />
          <stop offset="45%"  stopColor="var(--rim-hi)" stopOpacity="0.05" />
          <stop offset="100%" stopColor="var(--rim-lo)" stopOpacity="0.32" />
        </linearGradient>
        <radialGradient id="pool" cx="50%" cy="45%" r="50%">
          <stop offset="0%"   stopColor="var(--table-pool)" stopOpacity="0.42" />
          <stop offset="100%" stopColor="var(--table-pool)" stopOpacity="0" />
        </radialGradient>
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
      </defs>

      <ellipse cx="500" cy="336" rx="432" ry="256" fill="var(--table-shadow)" filter="url(#soft)" />
      <ellipse cx="500" cy="310" rx="432" ry="256" fill="url(#rim)" />
      <ellipse cx="500" cy="310" rx="414" ry="241" fill="url(#surface)" />
      <ellipse cx="500" cy="300" rx="300" ry="168" fill="url(#pool)" />
      <ellipse
        cx="500" cy="310" rx="378" ry="218"
        fill="none" stroke="var(--table-ring)" strokeWidth="1" opacity="0.35"
      />
      <ellipse
        cx="500" cy="310" rx="392" ry="228"
        fill="none" stroke="var(--table-ring)" strokeWidth="0.5" opacity="0.18"
      />
    </svg>
  );
}
```

The `pool` gradient is the seat of the room lighting. Under the war-room theme it is a cold blue; under the hearth theme it is a warm lamp. It is the single element that most changes the mood, which is why it is a token and not a literal colour.

**Step-reactive surface.** The table itself carries state: during `propose` the rim brightens slightly, during `debate` the engraved rings gain a slow 24-second rotation, during `vote` the centre plinth appears (section 16.7), during `reveal` a single outward ripple crosses the surface. All of these are `opacity` and `transform` animations on existing elements, never new geometry, so the SVG never re-renders.

### 16.3 Avatar system

**Hard rule: no photographic faces, no realistic human illustration, no style that implies a person.** The table is a council of lenses, not eight people. Realistic avatar styles in the DiceBear collection (`avataaars`, `personas`, `notionists`, `adventurer`) are **banned**; the picker must not offer them.

Three styles, selectable per seat on `/agents`, stored in `agents.avatar_style`:

**1. `dicebear` — default.** Abstract generative geometry, deterministic from a seed, generated locally with no network call.

```ts
// src/lib/avatars/dicebear.ts
import { createAvatar } from '@dicebear/core';
import { shapes, rings, glass } from '@dicebear/collection';

const STYLES = { shapes, rings, glass } as const;

export function renderAvatarSvg(opts: {
  style: keyof typeof STYLES;
  seed: string;
  accent: string;
}): string {
  return createAvatar(STYLES[opts.style], {
    seed: opts.seed,
    size: 128,
    backgroundColor: [],      // transparent: the seat ring supplies the colour field
    shape1Color: [opts.accent],
    shape2Color: ['transparent'],
    shape3Color: [opts.accent],
  }).toString();
}
```

**Requirements:** the background is always transparent so the seat's accent ring is the colour field, not the avatar. The seed is `agents.avatar_seed`, defaulting to `seat_key`, so the same seat always renders the same shape. The SVG is generated once and written to `agents.avatar_svg_cache`; reads use the cache, and a "reroll" button on the seat form clears it with a new seed. Generation happens on the server, never in the browser, so the dependency stays out of the client bundle.

**2. `lucide` — alternate.** One persona icon in an accent-tinted circle. Fastest to read at a glance, zero generation, useful for a cleaner or more corporate look. Default icon per seeded seat:

| Seat | Icon |
|---|---|
| Me Agent | `user-round` |
| The Pragmatist | `hammer` |
| The Wildcard | `dices` |
| The Market Analyst | `trending-up` |
| The Technical Architect | `blocks` |
| The Contrarian | `swords` |
| The Mentor | `compass` |
| The Trend-Watcher | `radar` |

**3. `initials` — fallback.** Two-letter monogram in the seat accent. Used when the seat is new and unconfigured, and as the graceful degradation if SVG generation fails. Never leave a seat without an avatar.

**Seat anatomy.** Every seat renders the same five stacked layers, and this order is fixed:

```
┌─ SeatAura        (behind, animated glow, thinking only)
│ ┌─ SeatRing     (2px ring in accent, accent-tinted fill at 12% alpha)
│ │ ┌─ Avatar     (the SVG or icon, inset 3px)
│ │ │ ┌─ WeightBadge   (bottom-right, "25%" in tabular numerals)
│ │ │ │ ┌─ NameLabel   (below the ring, 13px, text-dim)
│ │ │ │ │ ┌─ SpeechBubble (below the name, highest z, section 16.6)
```

The weight badge is always visible, not hidden behind a hover. The whole point of the product is weighted voting; a user should be able to see the 25 percent seat without asking. It updates live from the normalised-weight preview.

### 16.4 Seat visual states

Five states, driven by the run reducer, never by local component state.

| State | Ring | Avatar | Overlay | Text |
|---|---|---|---|---|
| `idle` | Accent at 35% alpha | `saturate(0.55)` | none | Name at `--text-dim` |
| `thinking` | Accent at 100%, aura active | `saturate(1.15)`, scale 1.06 | Thought cloud, section 16.5 | Name at `--text` |
| `spoken` | Accent at 100% | `saturate(1)`, scale 1 | none | Speech bubble with the take |
| `failed` | Accent replaced by `--danger` | `saturate(0.3)` | Alert icon replaces the cloud | Error code in the bubble |
| `disabled` | `--line`, no accent | 40% opacity | none | Struck-through name, weight shown as 0% |

**Seat accent palette.** Default assignment, chosen so no two adjacent seats share a hue family and the Me Agent owns the only gold on the table:

| Seat | Dark theme hex | Light theme hex | Rationale |
|---|---|---|---|
| Me Agent | `#F0B429` | `#B45309` | Gold. The only warm-metal colour at the table, so the user's seat is unmistakable |
| The Pragmatist | `#4ECDC4` | `#0F766E` | Cool teal, calm and grounded |
| The Wildcard | `#E879F9` | `#A21CAF` | Magenta. Highest chroma on the table, for the loudest seat |
| The Market Analyst | `#4ADE80` | `#15803D` | Green, the universal money colour |
| The Technical Architect | `#60A5FA` | `#1D4ED8` | Blue, structural and neutral |
| The Contrarian | `#F87171` | `#B91C1C` | Red. Reserved for the seat that attacks |
| The Mentor | `#A78BFA` | `#6D28D9` | Violet, senior and steady |
| The Trend-Watcher | `#22D3EE` | `#0E7490` | Cyan, the only near-neighbour of teal, placed adjacent on purpose so the two read as a related pair |

Every accent **MUST** clear a 3:1 contrast ratio against the table surface in its theme for the ring and glow, and 4.5:1 for any text drawn in it. Verify with a contrast checker before shipping; adjust lightness, never hue, if a value fails.

### 16.5 The thinking indicator

Two layers, running together. The aura communicates "this seat is active", the dots communicate "this seat is composing output". Together they read as an AI thinking rather than a chat app typing.

**Layer 1 — the aura.** A pulsing glow ring. The critical implementation detail: the `box-shadow` itself is static and only `opacity` and `scale` animate. Animating a `box-shadow` value forces a paint every frame on every seat; animating opacity on a pre-shadowed element is composited on the GPU. With eight seats on screen this is the difference between smooth and janky.

```tsx
// src/components/table/SeatAura.tsx
export function SeatAura({ accent, active }: { accent: string; active: boolean }) {
  return (
    <AnimatePresence>
      {active && (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2.5 rounded-full"
          style={{ boxShadow: `0 0 0 2px ${accent}55, 0 0 30px 6px ${accent}40` }}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: [0.42, 0.95, 0.42], scale: [0.97, 1.05, 0.97] }}
          exit={{ opacity: 0, scale: 0.94 }}
          transition={{
            opacity: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
            scale:   { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
            exit:    { duration: 0.22 },
          }}
        />
      )}
    </AnimatePresence>
  );
}
```

**Layer 2 — the thought cloud.** A cloud-shaped container above the avatar holding three dots with a staggered opacity, scale, and vertical nudge. This is the classic typing indicator, and it is the right pattern because it is universally readable and costs nothing.

```tsx
// src/components/table/ThoughtCloud.tsx
export function ThoughtCloud({ accent }: { accent: string }) {
  return (
    <motion.div
      className="absolute -top-11 left-1/2 flex -translate-x-1/2 items-center gap-[5px]
                 rounded-full border border-[var(--line)] bg-[var(--bg-elev-2)]
                 px-2.5 py-2 shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
      initial={{ opacity: 0, y: 6, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.92 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-1.5 w-1.5 rounded-full"
          style={{ background: accent }}
          animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0], scale: [0.85, 1.1, 0.85] }}
          transition={{ duration: 1.15, repeat: Infinity, ease: 'easeInOut', delay: i * 0.16 }}
        />
      ))}
      {/* tail */}
      <span
        className="absolute -bottom-[5px] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45
                   border-b border-r border-[var(--line)] bg-[var(--bg-elev-2)]"
      />
    </motion.div>
  );
}
```

**Rationale for the cloud over a bare dot row:** the tail anchors it to the seat's head. Unanchored, the dots float and read as a page-level loader rather than as one seat's activity. Anchoring is what makes eight simultaneous clouds legible.

**Optional upgrade path — Lottie.** v1 ships no Lottie: it adds a dependency and an asset for something the 30 lines above already do well, and pre-made thinking animations tend to be stylistically mismatched with a dark war-room palette. If a richer animation is wanted later, `ThoughtCloud` accepts a `renderer` prop, and `lottie-react` plus a recoloured JSON asset drops in behind that one prop. The Lottie asset **MUST** be recoloured to the seat accent rather than used as downloaded; a stock blue loader inside a gold seat looks broken.

### 16.6 Speech bubble and the expand-to-drawer transition

**Speech bubble.** Enters from the seat with a short upward travel, holds a maximum of two lines, and truncates with a fade rather than an ellipsis mid-word.

```tsx
<motion.div
  layout
  initial={{ opacity: 0, y: 8, scale: 0.96 }}
  animate={{ opacity: 1, y: 0, scale: 1 }}
  exit={{ opacity: 0, y: 6, scale: 0.97 }}
  transition={{ type: 'spring', stiffness: 320, damping: 26, mass: 0.7 }}
  className="absolute top-[calc(100%+10px)] left-1/2 w-44 -translate-x-1/2 rounded-xl
             border border-[var(--line)] bg-[var(--bg-elev-2)] px-3 py-2 text-[12.5px]
             leading-snug text-[var(--text-dim)]"
  style={{ borderColor: `${accent}44` }}
>
  <p className="line-clamp-2">{take}</p>
</motion.div>
```

The bubble is not a chat log. It shows the seat's single most recent take, replaced as the run proceeds. The full history lives in the reasoning drawer and in the replay view.

**Shared-layout expand to the drawer.** Clicking a seat opens the reasoning drawer, and the seat's avatar animates into the drawer header rather than the drawer simply appearing. Framer Motion's shared layout animation does this with a matching `layoutId`, which is exactly the tool for "expand from this specific avatar's position":

```tsx
// Both nodes live inside the same <LayoutGroup>.
// Exactly ONE of them is mounted at a time, otherwise Framer cannot resolve the pair.

// In Seat.tsx
{!drawerOpenForThisSeat && (
  <motion.div layoutId={`avatar-${agentId}`} className="h-full w-full rounded-full">
    <Avatar agent={agent} />
  </motion.div>
)}

// In ReasoningDrawer.tsx
<motion.div layoutId={`avatar-${agentId}`} className="h-11 w-11 rounded-full">
  <Avatar agent={agent} />
</motion.div>
```

**Requirements:** wrap both in a single `LayoutGroup` at the page level. The seat's copy unmounts as the drawer's copy mounts, in the same commit, or the animation will not run. The drawer is a right-side sheet on desktop (480px) and a bottom sheet on mobile, with tabs across the top for each seat so the user can flick between live reasoning streams. Give the drawer `layoutScroll` on its content container so the shared layout animation does not fight the internal scroll.

**Inside the drawer.** Two stacked panes: the reasoning channel on top in `--text-mute` with a subtle italic treatment and a slow typewriter reveal, and the answer channel below in `--text`. When a model exposes no separate reasoning channel, the drawer collapses to a single pane and shows a one-line note, "this model does not expose its reasoning", rather than leaving an empty pane with no explanation.

### 16.7 The table centre during vote

The centre of the table is the focal point of the whole screen, so it carries the run's live state.

| Step | Centre contents |
|---|---|
| `propose` | Step name in small caps, letter-spaced, at 40% opacity |
| `debate` | The proposal count, and a thin arc of ticks around the inner ring, one per proposal, lighting up as critiques land |
| `refine` | The names of the seats currently revising, stacked vertically, fading in as they start |
| `vote` | The live ranking plinth, described below |
| `reveal` | The winner's title, in the largest type on the page |

**The vote plinth.** A vertical stack of one row per surviving proposal, ordered by current weighted score, reordering with a layout animation as votes arrive. Each row: proposal title truncated to 46 characters, a horizontal bar in the proposal's lead seat accent, and the numeric score.

```tsx
<motion.div layout transition={{ type: 'spring', stiffness: 260, damping: 30 }}>
  <motion.div
    layout
    className="h-1.5 rounded-full"
    style={{ background: leadAccent }}
    animate={{ width: `${(score / 10) * 100}%` }}
    transition={{ type: 'spring', stiffness: 120, damping: 22 }}
  />
</motion.div>
```

Rows reorder as votes land, so the user watches consensus form rather than reading a final table. This is the single most watchable moment of the run and the plinth **MUST** update incrementally per `agent.done` during the vote step, not once at `step.completed`. The server therefore includes a `partial_scores` payload on each vote-step `agent.done` event; the client renders it and never computes it (section 15.2).

### 16.8 Theme system

Two complete themes ship. Both are first-class: they are two token sets behind one `data-theme` attribute, not a theme and a half-maintained variant. The user switches on `/settings`, and the choice persists in the `settings` table.

**Why two, and what each is for.** The war-room theme is the default: eight saturated accent colours on a near-black surface read at a glance, the seat auras are legible, and the vote plinth's coloured bars carry well. The hearth theme exists because the product's other honest framing is "brainstorm with friends", and some runs want that. Both must be checked for contrast, not just for looks.

**Default: war room.** Near-black ground, cold rim light, saturated seats.

```css
/* src/styles/themes.css */
:root[data-theme='warroom'] {
  --bg:            #08090B;
  --bg-elev-1:     #0F1115;
  --bg-elev-2:     #161920;
  --bg-elev-3:     #1D2129;
  --line:          #232833;
  --line-strong:   #303746;
  --text:          #E7EAF0;
  --text-dim:      #9AA3B2;
  --text-mute:     #6B7280;
  --danger:        #F87171;
  --warn:          #FBBF24;
  --ok:            #4ADE80;

  /* table surface */
  --table-core:    #131A24;
  --table-mid:     #0E1219;
  --table-edge:    #090C11;
  --table-shadow:  rgba(0, 0, 0, 0.78);
  --table-pool:    #1D4ED8;
  --table-ring:    #2A3341;
  --rim-hi:        #C9D4E6;
  --rim-lo:        #000000;

  /* seat accents */
  --seat-1: #F0B429;  /* Me Agent */
  --seat-2: #4ECDC4;  /* Pragmatist */
  --seat-3: #E879F9;  /* Wildcard */
  --seat-4: #4ADE80;  /* Market Analyst */
  --seat-5: #60A5FA;  /* Technical Architect */
  --seat-6: #F87171;  /* Contrarian */
  --seat-7: #A78BFA;  /* Mentor */
  --seat-8: #22D3EE;  /* Trend-Watcher */

  --grid: rgba(255, 255, 255, 0.022);
}
```

**Alternate: hearth.** Parchment and worn wood, warm lamp light, collaboration register.

```css
:root[data-theme='hearth'] {
  --bg:            #F5EFE4;
  --bg-elev-1:     #FBF7EF;
  --bg-elev-2:     #FFFFFF;
  --bg-elev-3:     #FFFDF8;
  --line:          #E2D6C0;
  --line-strong:   #CFBE9F;
  --text:          #2B2118;
  --text-dim:      #6B5B45;
  --text-mute:     #8C7B62;
  --danger:        #B91C1C;
  --warn:          #92400E;
  --ok:            #15803D;

  --table-core:    #DCC9A8;
  --table-mid:     #C9B18C;
  --table-edge:    #B99A70;
  --table-shadow:  rgba(90, 70, 40, 0.32);
  --table-pool:    #F0B429;
  --table-ring:    #7A6242;
  --rim-hi:        #FFF6E6;
  --rim-lo:        #6B5433;

  --seat-1: #B45309;
  --seat-2: #0F766E;
  --seat-3: #A21CAF;
  --seat-4: #15803D;
  --seat-5: #1D4ED8;
  --seat-6: #B91C1C;
  --seat-7: #6D28D9;
  --seat-8: #0E7490;

  --grid: rgba(60, 40, 20, 0.045);
}
```

**Requirements.** Every colour in a component **MUST** be a token reference or a Tailwind utility derived from a token. No hex literal anywhere outside `themes.css`. Seat accents are applied via `var(--seat-N)` resolved from `agents.accent_token`, never from the raw `accent_color` value, so a single theme switch recolours all eight seats. `accent_color` exists only as an override for a user who wants a custom seat colour, and when set it **MUST** also be offered in both a dark and a light variant.

Both themes carry a faint background grid for depth (24px cell, `--grid`), drawn as a CSS `background-image` with two `linear-gradient` layers. No texture image assets in either theme.

### 16.9 Typography, spacing, radii, elevation

**Type.** Two faces, both loaded with `next/font` so there is no layout shift.

| Role | War room | Hearth | Notes |
|---|---|---|---|
| UI and body | Inter | Inter | One body face in both themes |
| Display, the winner title | Inter, tight tracking, 600 | Fraunces or Instrument Serif, 500 | The hearth theme's serif is its strongest single signal |
| Numerals, scores, weights | Inter with `font-variant-numeric: tabular-nums` | same | **MUST** be tabular. Scores that shift width while counting up look broken |

Scale, in `rem` at a 16px root: display 2.25, h1 1.5, h2 1.125, body 0.875, small 0.8125, micro 0.6875 with 0.08em letter-spacing for the small-caps step labels.

**Spacing.** A 4px base scale: 4, 8, 12, 16, 24, 32, 48, 64. Seat labels and bubbles use 8 and 12. Panels use 24 and 32. Sections use 48 and 64.

**Radii.** Pills and avatars 9999. Cards and bubbles 12. Panels and drawers 16. The table SVG has its own curvature and takes no radius.

**Elevation.** Three levels, defined per theme as shadow tokens rather than hardcoded utilities. Level 1 for speech bubbles, level 2 for cards and the plinth, level 3 for the drawer and modals. In the war-room theme elevation is expressed mostly through surface lightness with a soft black shadow; in the hearth theme it is mostly shadow with a light warm tint, because stacking light surfaces reads as mud.

**Focus rings.** 2px `--seat-5` (blue) at a 2px offset on every interactive element, never removed. Keyboard users navigate seats, and a focus ring that disappears over a dark table makes the product unusable without a mouse.

### 16.10 Staggered reveal

Agents run in parallel on the server; the table reveals in sequence to stay watchable. This is a client concern and **MUST** be implemented client-side.

1. Every `agent.delta` goes into a per-seat buffer. Nothing renders immediately.
2. A single `useStaggerQueue` hook drains buffers on a fixed cadence, default 45 milliseconds per release slot, advancing through seats in `order_index` order. A seat becomes `thinking` when its turn arrives, even if its server-side call already finished.
3. If a seat's buffer exceeds a high-water mark, default 4000 characters, the queue releases that seat faster until the buffer drains. The visual delay must never become a correctness bug.
4. On `agent.done`, the seat's buffer flushes at the accelerated rate and the seat transitions to `spoken` with the final one-liner.
5. `step.completed` force-flushes every remaining buffer before advancing the timeline, so a fast step can never leave a seat visually stuck mid-sentence.
6. If more than one seat is thinking at once after staggering, the auras phase-offset by 0.4 seconds each, so eight glows pulse in a visible wave rather than in unison. Unison reads as a loading screen; a wave reads as a room.
7. Cadence is configurable on `/settings`. Setting it to zero disables staggering and renders deltas as they arrive.
8. A "skip animation" control on the table flushes everything immediately, for when the user wants the result rather than the show.

### 16.11 Responsive behaviour

| Width | Layout |
|---|---|
| 1280px and above | Full ellipse, table SVG visible, drawer as a right sheet |
| 900 to 1279px | Same ellipse with `RADIUS_X` at 0.42, seat diameter at its 52px floor, bubbles narrow to 9rem and clamp to one line |
| 640 to 899px | Table SVG hidden, seats on a tighter ellipse, reasoning panel becomes a full-screen overlay |
| Below 640px | Compact layout: the ellipse is abandoned. Seats become a vertical `SeatStack` of rows, each row an avatar, a name, a weight badge, and an inline thought indicator. The step timeline becomes a horizontally scrollable strip. The vote plinth becomes a full-width list |

The compact layout is a real layout, not a degraded one: it is what the replay view uses for a run read on a phone, and it **MUST** be designed rather than fall out of a breakpoint accident.

### 16.12 Reduced motion and accessibility

- Respect `prefers-reduced-motion`. When set, `ThoughtCloud` renders a static ellipsis glyph instead of pulsing dots, `SeatAura` renders a solid non-animated ring at 60 percent opacity, and the stagger cadence drops to zero. State changes still occur; only the motion is removed.
- The reasoning drawer is reachable by keyboard. Seats are focusable in `order_index` order, Enter opens the drawer, Escape closes it, and focus returns to the seat that opened it.
- An `aria-live="polite"` region announces step transitions and the final winner, so a screen-reader user is not dependent on watching the table.
- State is never encoded in colour alone. Every seat state carries a text or icon affordance alongside its colour: the thought cloud, the alert icon, the struck-through name.
- Animated counting of scores is presentation only; the accessible name of every score element contains the final value from the first render.

### 16.13 Motion budget and performance rules

These are hard rules, because eight continuously animating seats plus a streaming text panel is enough to drop frames on a mid-range laptop.

- Animate only `transform` and `opacity`. Never animate `box-shadow`, `filter`, `width`, or `height` directly. Where a size change is needed, animate a transform on a wrapper. The vote plinth's bar is the one exception, because it is one element per proposal and not eight; it uses `width` deliberately.
- The aura glow is a static shadow on a wrapper whose opacity animates. This is the difference between a compositor-only animation and a full repaint every frame on every seat.
- Streamed text **MUST NOT** be wrapped in a motion component. Animating each token re-renders and re-lays-out the bubble hundreds of times per step. Instead, render plain text into a container and animate only the container's entrance once. The typewriter reveal in the drawer is a CSS mask over already-rendered text, not a per-character animation.
- Cap concurrent infinite animations. At most eight auras and eight clouds, and never animations on seats that are off-screen or in the `idle` state.
- `AnimatePresence` for every mount and unmount of a cloud, aura, or bubble, so nothing pops.
- The reasoning drawer's internal scroll uses `layoutScroll`, and the seat grid uses `LayoutGroup` with `layout` only on the elements that actually reorder, never on the whole table.
- Target 60 frames per second during a full eight-seat thinking step on a 2020-era laptop with the integrated GPU. If a step drops below 45, the fix is cadence and animation count, not a rewrite.

---

## 17. Guardrails, Budgets, and Failure Handling

### 17.1 Per-call limits

| Limit | Default | Configurable |
|---|---|---|
| `maxTokens` per proposal or refine call | 800 | per seat class in settings |
| `maxTokens` per critique call | 500 | |
| `maxTokens` per vote call | 600 | |
| `maxTokens` per reveal call | 1200 | |
| Request timeout | 90 seconds | settings |
| Retries | 2, exponential backoff 1s then 4s, plus jitter | settings |
| Retry applies to | 429, 5xx, network errors, `StructuredOutputError` | not to other 4xx |
| Concurrency | 8 in flight per step, global cap 8 | settings |

### 17.2 Run budget

`BudgetGuard` increments counters after every call and checks before dispatching the next task. Limits: `RUN_BUDGET_USD`, `RUN_MAX_TOKENS`, `RUN_MAX_CALLS`. At 80 percent of the cost limit it emits `budget.warning`. At 100 percent it throws `BudgetExceededError`, the engine marks the run `failed` with `error_code = 'BUDGET_EXCEEDED'`, and all completed artefacts are preserved. **The guard checks before dispatching, never mid-call**, so no partial result is ever orphaned.

Cost estimation uses `model_pricing` and the token counts returned by the provider, falling back to the character estimate from section 8.3 when usage is absent.

### 17.3 Partial-step tolerance

A step completes when every task resolves, whether successfully or with a recorded failure. If a failure leaves fewer than three active proposals, the run fails with `INSUFFICIENT_PROPOSALS`. Otherwise the run continues with the seats that succeeded, and failed seats render in the error pose with the reason, so a single provider outage degrades rather than kills the run.

### 17.4 Structured output failure

If two attempts at a call fail schema validation, the task fails with `StructuredOutputError`. The engine records the raw text in `agent_messages.error` for debugging. The reveal step is the one exception: if synthesis fails, the engine falls back to a deterministic template rendered from the stored scores, so a run that reached voting always produces a result card.

### 17.5 Provider outage

The seat-level design makes this survivable by construction: an all-DeepSeek outage still leaves five GLM seats plus the Me Agent's fallback, and the run completes with a note in the reveal payload listing the failed seats. The engine **MUST NOT** abort a run merely because one provider is down.

### 17.6 Process restart

In-flight runs do not survive a hard restart in v1; `runs` is swept at boot, and any row in `running` with no live orchestrator is marked `failed` with `error_code = 'PROCESS_RESTART'`. All artefacts up to that point are preserved and the run remains browsable and replayable. `scripts/smoke-run.ts` exists so a full run can be verified headlessly after any restart concern.

---

## 18. Run History, Replay, Export, Compare

### 18.1 Browse

`/runs` lists runs newest first with seed prompt, created date, status, winner title, winning score, cost, and duration. Filters by status and by seed-prompt substring. Clicking a row opens `/runs/[id]`.

### 18.2 Replay

`/runs/[id]` reconstructs the entire table from stored rows. It reads `run_events` ordered by `seq` and re-emits them into the same reducer the live view uses, on a timer. **MUST** make zero LLM calls. Includes a scrubber over step boundaries so the user can jump straight to the vote or the reveal. Replay is the demo mode: it makes the product presentable without spending a cent.

### 18.3 Export

`GET /api/runs/:id/export?format=md` produces a Markdown document containing: the seed prompt, the profile version used, every proposal with its author and score, all critiques grouped by target, the full vote table with normalised weights, the winner with its rationale, the dissent list, and the run metrics. `format=json` returns the raw rows. Both are also offered from the UI as a copy-to-clipboard action.

### 18.4 Compare

`/runs/compare?a=&b=` renders two runs side by side: seed prompts, winner titles and scores, the metric table from section 12.5 with deltas, and the seats that changed between the snapshot configs. The point of the view is answering "did changing my profile or the seed actually change the outcome", so the weight and profile diffs are rendered first, above the results.

---

## 19. Testing Specification

Two layers, both required. No browser automation in v1.

### 19.1 Unit tests (`vitest`, `src/test/unit`)

| Target | Cases |
|---|---|
| `weights.ts` normalisation | Default eight seats sum to 1 with the Me Agent at 0.25; disabling a seat renormalises; adding a seat renormalises; zero total weight is rejected with a typed error |
| `weights.ts` scoring | Weighted score matches a hand-computed fixture; a zero-weight seat cannot change the outcome; more than one seat per provider does not skew results |
| Tie-break | Each of the five rules exercised in isolation, plus a fully tied fixture resolving by id |
| Dissent | Boundary cases at exactly `mean - 2` and a score of exactly 5 on the winner |
| State machine | Every legal transition accepted, every illegal transition rejected with a typed error; refine skipped when disabled and when no critiques exist |
| `budget.ts` | Warning fires at 80 percent; abort fires exactly at the limit, not after; checks happen before dispatch |
| `json.ts` | Clean JSON, JSON wrapped in prose, JSON in a fenced block, truncated JSON repaired on retry, two failures raising `StructuredOutputError` |
| `digest.ts` | Truncation respects the token budget; the winner-per-step is always retained; determinism for the same input |
| `staggerQueue` | Order follows `order_index`; high-water mark accelerates release; force-flush empties all buffers; zero cadence is a pass-through |
| `layout/seats.ts` | Seat count matches the input; every coordinate lies within 0 to 100; adjacent seat gaps are uniform within 2 percent, proving arc-length spacing rather than angle spacing; index 0 lands at 12 o'clock; the function is stable for 2, 3, 8, and 16 seats |
| Avatar generation | The same seed produces a byte-identical SVG; different seeds produce different output; the resolved style is always abstract, never a banned realistic style; a generation failure falls back to initials rather than throwing |
| Theme tokens | Both token sets define the same key list, so no component can reference a missing token; every accent clears its required contrast ratio against its theme's table surface |
| `merge.ts` | Locked and manual items survive regeneration; matched generated items update in place; removed generated items are hidden, not deleted |
| `summary.ts` | Output is deterministic; `author_brief` stays under 400 words |
| Export | Markdown contains every required section; JSON round-trips against the schema |
| Provider adapter | Recorded fixtures for a DeepSeek reasoning stream and a GLM stream, asserting reasoning and text deltas are classified correctly |

### 19.2 Integration tests (`src/test/integration`)

`MockLLMAdapter` implements `LLMAdapter`, replays scripted deltas from a fixture file with configurable latency and injectable failures, and records every request. Tests run against a temporary SQLite file created per suite.

| Scenario | Assertion |
|---|---|
| Full happy-path run | Terminal status `completed`, winner present, `final_score` matches a recomputed value, event sequence is well-formed and gapless |
| Pause mid-propose | No task is aborted; no new task is dispatched after the flag; status is `paused`; pending keys reported |
| Resume | Already-completed task keys are not re-requested; the run reaches `completed`; the call count equals the un-paused count |
| Budget abort | Status `failed` with `BUDGET_EXCEEDED`; the partial run is browsable; no call is made after the limit |
| Seat failure | One seat's every call fails; the run still completes; the failed seat appears in the reveal payload |
| Structured output failure | Two bad responses for one seat degrade that seat only |
| Provider outage | All DeepSeek seats failing still yields a completed run |
| Contract | Each route handler rejects an invalid body with 400 and a typed error code |
| Replay | Replaying a completed run makes zero adapter calls and produces an identical reducer state |

### 19.3 Commands

```
pnpm test           # vitest run, unit + integration
pnpm test:watch     # vitest
pnpm test:coverage  # coverage report, threshold 80% on src/lib
pnpm typecheck      # tsc --noEmit
pnpm lint
pnpm db:generate    # drizzle-kit generate
pnpm db:migrate     # apply migrations
pnpm seed           # seed user, agents, pricing
pnpm smoke          # scripts/smoke-run.ts, real APIs, one full run
```

---

## 20. Milestones and Acceptance Criteria

Each milestone ends in a working, committed state with tests green.

### M1 — Foundation and Me Agent profile pipeline

Bootstrap the app, database, config module, and the profile editor.

**Deliverables:** repository scaffold, Drizzle schema and migrations, seed script, `config.ts`, GitHub ingestion, CV ingestion, local scan, notes ingestion, extraction, merge, summary rendering, profile API routes, `/profile` editor UI, `scripts/ingest-profile.ts`.

**Acceptance:** running `pnpm ingest-profile` against a real GitHub account produces a populated profile; the summary preview shows exactly what agents will receive; a hand-added locked item survives a full regeneration; editing an item regenerates both summaries.

### M2 — Orchestration state machine with mocked agents

Build the whole loop before wiring real models.

**Deliverables:** adapter interface, `MockLLMAdapter`, engine, scheduler, steps for all five phases, bus, budget guard, idempotency keys, digest, full integration test suite.

**Acceptance:** `pnpm test` passes with the full happy path, pause, resume, budget abort, and provider-outage scenarios. `scripts/smoke-run.ts` with `MOCK_LLM=true` writes a complete run to SQLite with correct scores.

### M3 — Backend streaming and run-state API

**Deliverables:** SSE route handler with replay and heartbeat, delta coalescing, all run route handlers, event persistence, polling fallback endpoint.

**Acceptance:** opening the stream in a raw client during a mocked run shows ordered, gapless events with reasoning and text channels separated. Reconnecting with `Last-Event-ID` mid-run replays only the missed events and continues. Pause and resume round-trip correctly over HTTP.

### M4 — Round table UI

**Deliverables:** everything in section 16 — `layout/seats.ts` with arc-length placement, `TableSurface`, `Seat`, `SeatAura`, `ThoughtCloud`, `Avatar` with all three styles, `SpeechBubble`, `CenterPlinth`, `ReasoningDrawer` with shared-layout expansion, `StepTimeline`, `Controls`, and both theme token sets.

**Acceptance, behaviour:** a mocked run renders end to end with seats animating in sequence. Clicking a thinking seat streams its reasoning and the avatar visually expands into the drawer. Stop pauses, Resume continues, the timeline reflects the real step. Zero-cadence mode renders as fast as the server sends. The vote plinth reorders incrementally as each vote lands, not once at the end.

**Acceptance, craft:** the layout unit test in section 19.1 passes, proving arc-length spacing is uniform. Both themes render every screen with no hex literal outside `themes.css`. Every seat accent clears its contrast ratio in both themes. Swapping themes recolours all eight seats with no other change. The table holds 60 frames per second during an eight-seat thinking step with the performance rules in section 16.13 in force, and at least 45 frames per second with them deliberately violated, to confirm the rules are load-bearing. `prefers-reduced-motion` removes all motion while preserving every state change.

### M5 — Real agents wired in

**Deliverables:** `OpenAICompatibleAdapter`, registry, provider-quirk handling, pricing table, real DeepSeek and GLM routing, tuned lens prompts, Tavily search for the Trend-Watcher, reveal synthesis.

**Acceptance:** `pnpm smoke` completes a real run with all eight seats producing distinct, non-redundant output. Reasoning from the DeepSeek seat appears in the drawer and not in the speech bubble. The Trend-Watcher's critiques reference actual search results. Two runs on different seeds produce materially different idea sets.

### M6 — Reveal card, history, replay, export, compare

**Deliverables:** reveal card with dissenting opinions, metrics, history list, token-free replay with scrubber, export in both formats, comparison view.

**Acceptance:** a completed run exports to Markdown containing every required section. Replay reproduces the same final state with zero API calls. The comparison view shows metric deltas and the seat-config diff between two runs. The winner card lists dissent with seat colours and scores.

### Definition of done for v1

All six milestones merged. `pnpm typecheck`, `pnpm lint`, and `pnpm test` clean. Coverage at or above 80 percent on `src/lib`. A real run of two different seed prompts completes inside the default budget. `README.md` explains setup, environment variables, and how to run a first generation, with screenshots of the table and the reveal card.

---

## 21. Risks and Known Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agents converge on similar ideas, debate becomes noise | High | High | Distinct, sharply differentiated lens prompts with explicit anti-overlap instruction; `distinctness` metric stored per run so drift is measurable, not guessed; tuning pass in M5 |
| DeepSeek reasoning latency makes a step feel frozen | Medium | Medium | Reasoning deltas stream immediately, so the seat shows thinking within a second; 90-second timeout; per-seat provider split means GLM seats finish early and keep the table lively |
| Reasoning models ignore the JSON schema | Medium | Medium | `json.ts` extraction plus one repair retry; per-task failure isolation; reveal has a deterministic fallback |
| Cost creep from a large proposal set | Medium | Medium | Vote and debate are one call per agent, not one per target; refine is capped at four seats; hard budget abort checked before dispatch |
| SQLite write contention across eight parallel writers | Low | Medium | WAL mode; task completion writes are single short transactions; deltas are coalesced and never written per token |
| Profile inference is wrong and poisons every seat | Medium | High | Everything is editable with per-item provenance, locked items survive regeneration, regeneration shows a diff before applying, and `/profile/test` previews the effect of an unsaved draft |
| `better-sqlite3` or PDF parsing blocks the server event loop | Low | Medium | Scripts and heavy parsing run in a worker thread or in the CLI script; API ingestion is per-source and small |
| Event bus is in-process, so a hosted multi-instance deploy breaks | Low in v1 | High later | The bus is behind an interface with a documented Redis swap; no other module assumes in-process delivery |

---

## Appendix A — Structured Output Schemas

All schemas are Zod objects, used both to validate model output and to generate the schema text injected into prompts. Field names must match exactly; the prompt states them verbatim.

### A.1 Propose

```json
{
  "proposals": [
    {
      "title": "string, max 80 chars, concrete project name",
      "description": "string, 2-4 sentences, what it is and what it does",
      "rationale": "string, 1-2 sentences, why your lens favours this",
      "feasibility_weeks": 2
    }
  ]
}
```

One or two entries. `feasibility_weeks` is an integer estimate the Pragmatist seat and the reveal card both use.

### A.2 Debate

```json
{
  "critiques": [
    {
      "target_title": "string, must match a title from the proposals list verbatim",
      "stance": "support | attack | extend",
      "comment": "string, 1-3 sentences, max 90 words"
    }
  ]
}
```

Two or three entries, and at least one must target a proposal the agent did not author. The engine resolves `target_title` to `target_proposal_id` with a normalised string match and drops unmatchable critiques with a warning rather than failing the task.

### A.3 Refine

```json
{
  "refined": {
    "title": "string, max 80 chars",
    "description": "string, 2-4 sentences",
    "rationale": "string, 1-2 sentences describing what changed and why",
    "merges_proposal_titles": ["string"]
  }
}
```

`refined` may be `null` when the agent chooses not to revise.

### A.4 Vote

One call returns scores for every surviving proposal.

```json
{
  "votes": [
    {
      "proposal_title": "string, exact match required",
      "score": 7,
      "comment": "string, one sentence explaining the score"
    }
  ]
}
```

`score` is an integer from 1 to 10. Missing proposals are treated as a score of 1 with a recorded warning, so silent omission is visible rather than invisible.

### A.5 Reveal

```json
{
  "title": "string",
  "description": "string, 3-5 sentences, the winning idea expanded",
  "why_it_won": "string, 2-4 sentences grounded in the vote pattern",
  "first_steps": ["string, 3-5 concrete next actions"],
  "risks": ["string, 2-4 risks drawn from the dissent"]
}
```

### A.6 Profile item extraction

```json
{
  "items": [
    {
      "kind": "skill | project | taste | experience | constraint | goal | anti_pattern",
      "label": "string, max 60 chars",
      "detail": "string, 1-3 sentences of evidence",
      "confidence": 0.85
    }
  ]
}
```

Maximum twelve items per source. The prompt requires conservative output: emit nothing rather than speculate.

---

## Appendix B — Prompt Templates

These are the seeded defaults for `lens_prompt`. They are data, editable in the UI. They are written to be maximally distinct from each other; redundancy between seats is the main quality risk in the whole system.

### B.1 System contract (code constant, not editable)

```
You are a participant in a structured multi-agent idea workshop. You have one
role: {seat name}. You speak only from that role's perspective.

Rules:
- Output only the requested JSON object. No prose before or after it.
- Never mention that you are an AI, never address the user, never describe
  your own process.
- Be concrete. Name technologies, name the user-facing action, name the outcome.
- Respect the word limits given in the task.
- Do not repeat an idea already present in the discussion.
- If you have nothing useful to add, return an empty result rather than filler.
```

### B.2 The Pragmatist

```
You judge every idea by one question: can this be shipped in two weeks, by one
person, with tools they already know? You reward small scope, boring technology,
and a first version that works on day one. You punish anything requiring a
trained model, a hardware purchase, a data acquisition problem, or a design
system. Estimate weeks honestly and call out the single step most likely to
stall the project.
```

### B.3 The Wildcard

```
You exist to prevent boring answers. You push the strange, the playful, the
technically unnecessary, the idea that makes someone say "why would you build
that" and then want it anyway. Reject anything that looks like a portfolio
project or a tutorial rebuild. One of your ideas should be genuinely odd but
still buildable by one person. Novelty of interaction matters more than novelty
of stack.
```

### B.4 The Market Analyst

```
You care about whether anyone would use or pay for this. You look for a real
problem with a specific user, an existing behaviour you can improve, and a
plausible path to the first ten users. You are sceptical of ideas whose only
user is the builder. When you critique, name the user, the alternative they use
today, and what would have to be true for them to switch.
```

### B.5 The Technical Architect

```
You judge engineering quality and learning value. You favour ideas where the
interesting part is the structure: a protocol, a pipeline, a state machine, a
data model, an interface boundary. You are bored by CRUD and by thin wrappers
around an API. You ask what the system has to get right, what the hard invariant
is, and what the builder will understand better at the end than at the start.
```

### B.6 The Contrarian

```
You attack. You attack the strongest idea in the room, not the weakest, because
that is where the value is. For every proposal you name the specific reason it
fails: the hidden assumption, the dependency that will break, the part that
sounds easy and is not, the reason the builder will quit in week three. State
what evidence would change your mind. You are not negative for sport: you are
the reason the surviving idea is actually good.
```

### B.7 The Mentor

```
You are a senior engineer who has watched this person's history. You know their
pattern of abandoned projects and you name it directly when an idea repeats it.
You flag scope creep, unclear stopping conditions, and ideas whose appeal comes
from the setup rather than the thing itself. You favour ideas with a visible
finish line and a working artefact at the end of week one. Be warm but blunt.
```

### B.8 The Trend-Watcher

```
You bring the outside world. You receive live search results and use them: what
shipped recently, what is saturated, what just became possible because a model,
API, or price changed. You call out ideas that already exist in five forms, and
you point at newly viable directions. Cite what you found in plain terms; never
invent a source or a product that is not in your search results.
```

### B.9 The Me Agent

```
You are the user's own voice at the table, built from their real history.

You know their actual stack, their real skill level, what they finish, what they
abandon, and what they claim to want. Your job is to propose only work this
specific person will actually complete, and to vote against ideas that flatter
them but do not fit.

Cite the profile when you propose or object: name the skill, the constraint, or
the past pattern you are reasoning from. If an idea is exciting but conflicts
with a stated constraint, say so plainly and still let the table decide.

You carry 25 percent of the vote. Do not use it to be agreeable.
```

### B.10 Step instructions (code constants, parameterised)

| Step | Instruction skeleton |
|---|---|
| propose | `Seed: {seed}. Seed mode: {vague \| specific}. Author brief: {brief}. Propose {1-2} ideas from your lens. Return the propose JSON.` |
| debate | `Seed: {seed}. Proposals: {numbered list of title and description}. Pick {2-3} to critique, at least one not your own. Attack what actually fails, support what works, extend what is half-good. Return the debate JSON.` |
| refine | `Your proposal: {title, description}. Critiques it drew: {critiques}. Revise it if the critiques are right, merge with another proposal if the merge is stronger, or return null if it should stand. Return the refine JSON.` |
| vote | `Seed: {seed}. Surviving proposals: {numbered list with digests of their critiques}. Score each from 1 to 10 from your lens. One sentence of justification each. Use the full range; do not cluster at 7. Return the vote JSON.` |
| reveal | `Winning proposal: {proposal}. Score pattern: {per-seat scores}. Dissent: {dissent rows}. Expand the winner into a buildable plan and ground the rationale in the vote pattern. Return the reveal JSON.` |

---

## Appendix C — Model Reference and Assumptions to Verify

Verify these against live provider documentation as the first action of milestone M5. Model identifiers change; treat the table as a starting default, not a fact.

| Assumption | Verify | Fallback if wrong |
|---|---|---|
| DeepSeek chat and reasoning models are served at an OpenAI-compatible `/chat/completions` under `https://api.deepseek.com/v1` | Send one request and inspect the shape | Adjust `DEEPSEEK_BASE_URL`; the adapter is the only place that changes |
| DeepSeek reasoning models expose a reasoning channel field on streaming deltas | Log one raw delta during M5 | If absent, the reasoning drawer falls back to showing answer text with a note |
| GLM chat completions are served under `https://open.bigmodel.cn/api/paas/v4` with Bearer auth | Send one request and inspect the shape | Adjust `GLM_BASE_URL` |
| GLM model identifiers and the thinking-mode parameter name | Provider docs | Update `agents.model_id` rows via `/agents` or the seed script; no code change |
| Both providers return token usage on streaming responses | Inspect one streamed response | The adapter's character-based estimate keeps the budget guard functional |
| Tavily's search endpoint and response shape | One request | The `SearchAdapter` interface isolates it; the stub adapter keeps development unblocked |
| GitHub PAT scopes needed: read access to public and private repository metadata and contributions | GitHub docs | Without a token, ingestion still works but is rate limited to 60 requests per hour |

**Pricing seed.** Populate `model_pricing` with the current per-million-token input and output prices for each model in use at seed time, and record the date they were checked. The budget guard is only as accurate as this table, so the `/settings` page must show the last-updated date and offer a manual edit.

---

*End of specification. Every section above is a build requirement. Where this document is silent, choose the simplest implementation consistent with sections 2 and 4, write a test, and record the decision in the pull request description.*
