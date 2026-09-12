# Round Table

**Weighted multi-agent idea generator.** Eight AI seats around a virtual
round table generate, debate, refine and vote on project ideas. Seven seats
carry distinct evaluative lenses; the eighth — the **Me Agent** — is built
from your real GitHub history, CV, past projects and hand-written taste notes,
and holds 25% of the vote.

`architecture.md` is the single source of truth for the design. This README
covers setup and daily use only.

## Prerequisites

- Node.js 20 LTS or newer
- pnpm (current)
- A Zhipu **GLM API key** — every seat runs on GLM (`glm-5.3-flash` by
  default). There is no second provider.

## Setup

```bash
pnpm install
cp .env.example .env.local   # then fill in GLM_API_KEY (see below)
pnpm db:migrate              # create data/roundtable.db from drizzle/
pnpm seed                    # local user + eight seats + token pricing
pnpm dev                     # http://localhost:3000 (redirects to /run)
```

Open `/run`, type a seed prompt, and press Generate.

## Environment

All variables are read through `src/lib/config.ts` and nowhere else.
The app boots with no keys configured and fails only on an actual
generation attempt.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GLM_API_KEY` | yes | — | Zhipu GLM key; the only provider |
| `GLM_BASE_URL` | no | `https://open.bigmodel.cn/api/paas/v4` | Override for proxies |
| `TAVILY_API_KEY` | for live search | — | Trend-Watcher seat; unset = stub results |
| `GITHUB_TOKEN` | recommended | — | Read-only PAT; without it, 60 req/hour |
| `GITHUB_USERNAME` | for ingestion | — | Account to analyse |
| `DATABASE_URL` | no | `file:./data/roundtable.db` | SQLite path |
| `APP_USER_ID` | no | `local-user` | Single seeded user id |
| `SEARCH_PROVIDER` | no | `tavily` | `tavily` or `stub` |
| `RUN_BUDGET_USD` | no | `1.00` | Per-run cost ceiling (warns at 80%) |
| `RUN_MAX_TOKENS` | no | `250000` | Per-run token ceiling |
| `RUN_MAX_CALLS` | no | `60` | Per-run call ceiling |
| `LOG_LEVEL` | no | `info` | pino level |
| `MOCK_LLM` | no | `false` | `true` = scripted adapters, zero tokens |

## Daily use

| Page | Purpose |
|---|---|
| `/run` | Live table: generate, stop (pauses), resume, reveal card |
| `/runs` | History, token-free replay, export (Markdown/JSON), compare |
| `/agents` | Edit all eight seats: lens, model, weight, avatar |
| `/profile` | Me Agent editor: items, locks, regenerate diff, one-call test |
| `/settings` | Budgets, pacing, theme, provider presence (never values) |

Stop **pauses**: in-flight calls finish, nothing new dispatches, and Resume
continues from the next pending task without paying twice.

## Profile pipeline (the Me Agent)

```bash
pnpm ingest-profile [--source github|cv|local_scan|notes ...] [--force]
  [--cv <path>] [--local <path> ...] [--notes <path>] [--apply]
```

Without `--apply` the result stays a draft and the diff is printed for
confirmation — the same guarantee the `/profile` Regenerate button gives.
Locked and hand-written items survive every regeneration. Taste notes live in
`data/notes/taste.md`; drop a CV into `data/uploads/`.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` / `build` / `start` | Develop / build / serve production |
| `pnpm typecheck` | `tsc --noEmit` (CI gate) |
| `pnpm lint` | Next lint |
| `pnpm test` | Vitest: unit + integration (mocked, token-free) |
| `pnpm test:coverage` | Coverage; threshold 80% on `src/lib` |
| `pnpm db:generate` | Regenerate `drizzle/` from the schema |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm seed` | Idempotent seed (safe to re-run; never clobbers seat edits) |
| `pnpm ingest-profile` | CLI profile pipeline (see above) |
| `pnpm smoke` | Headless full run; `MOCK_LLM=true pnpm smoke` for offline |

## Provider notes

GLM always thinks and bills thinking tokens against `max_tokens`
(`docs/PROVIDER-NOTES.md`). The adapter therefore adds reasoning headroom to
every request and never sends a thinking-disable block (rejected with a 400).
`reasoning` and `jsonMode` are hints; correctness lives in `lib/llm/json.ts`
(extraction + one repair retry). See `docs/PROVIDER-NOTES.md` for the verified
live behaviour, including the retired DeepSeek record.

## Screenshots

Capture from a live session: the table mid-debate (`/run`), and the reveal
card with dissent after a run completes. Replay (`/runs/[id]`) reproduces both
without spending tokens, which is the easiest way to stage them.

## Testing

- `src/test/unit` — weights, tie-break, dissent, budgets, structured JSON,
  digests, seat layout, stagger queue, merge/summary, export, GLM adapter
  fixture, avatars, theme tokens/contrast, state machine.
- `src/test/integration` — full engine runs on a temp database: happy path,
  pause/resume idempotency, budget abort, seat failure, structured-output
  failure, total-outage honesty, token-free replay, boot sweep.
