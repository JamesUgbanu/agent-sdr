# Agent SDR

An open-source, production-grade **AI SDR (Sales Development Representative)** system: define your ideal customer, let the agent discover and research prospects, draft evidence-backed outreach, approve it (or let policy approve it), send multi-step sequences, handle replies, book meetings, and sync your CRM — all under explicit guardrails, with every action audited.

Most "AI SDR" projects are an email prompt with a UI. This one is a **controlled agentic loop**: the LLM observes run state and chooses the next tool from a registry, while deterministic code owns state, budgets, suppression, idempotency, approvals, and audit. Postgres is the source of truth, not the model.

> **Need help with deployment or integration?** I can help you understand how Agent SDR
> fits into your existing workflow, adapt it to your requirements, and get it deployed.
> See the [Agent SDR product page](https://agents.jamesugbanu.com/agents/sdr-agent/) to learn more.

## Demo video

> 🎬 *Coming soon — a walkthrough of campaign setup, the approval queue, and a full prospect lifecycle will live here.*

## Why this exists

Outbound prospecting is high-leverage and easy to get wrong: hallucinated personalization burns domains, duplicate sends burn reputation, and black-box "AI" gives you no audit trail. Agent SDR is built around three convictions:

1. **Evidence before outreach** — every personalization claim must trace to a stored source, or the message doesn't send.
2. **Autonomy inside guardrails** — the agent decides what to do next, but budgets, suppression lists, approval policies, opt-outs, and idempotency are deterministic code the model cannot override.
3. **Everything auditable** — every run, tool call, token, and decision is persisted and visible in the activity timeline.

## Features

- **Campaigns + ICP** — geography, industries, company size, titles, tech stack, offer, sending limits, working hours, approval policy (`manual` / `assisted` / `autonomous`).
- **Prospecting** — provider interface (Apollo, Hunter, People Data Labs + deterministic dev seed) with suppression pre-checks before any spend.
- **Enrichment + email verification** — confidence levels (`verified`…`unknown`); NeverBounce/Hunter adapters; explicit `unavailable` state instead of faked results.
- **Evidence-first research** — website/careers signals stored with `source_url`, `claim`, `confidence`; workspace-scoped research cache.
- **Explained lead scoring** — weighted factors (company/role/geo/intent/signal/data), never a bare number.
- **Claim-validated personalization** — drafts that fail evidence checks never send.
- **Human approval queue** — lead, research, signals, score, evidence, draft, and reason on one card; approve / reject / edit / regenerate / pause.
- **Multi-step sequences** — explicit state machine (`NEW` → … → `MEETING_BOOKED`, plus terminal states); replies and unsubscribes auto-stop sequences.
- **Reply handling** — webhook ingestion, rules + LLM classification (`interested`, `pricing_question`, `unsubscribe`, …), knowledge-grounded conversational replies with human handoff when knowledge is insufficient.
- **Meetings + CRM** — real-availability booking (Google/Outlook adapters + flow), HubSpot/Salesforce sync with a persisted ledger (failures are never silent).
- **Observability** — SSE activity stream, per-run token/cost tracking, campaign analytics, dead-letter queue with owner-gated retry.
- **Auth + isolation** — Auth.js sessions, workspace membership enforcement on every mutating route, AES-256-GCM secret storage, rate limiting.

## How it works

```
Campaign config → Agent loop → tool → deterministic app → integration
       ↑                           (observes result, chooses next tool)
```

`runAgent()` runs a genuine decision loop (see `src/server/agents/orchestrator.ts`): build a state snapshot → LLM selects the next tool from the run-type permission set (native function-calling on OpenAI, validated JSON-mode otherwise) → validate name + args against the registry → execute → persist step + tool call → feed results back → repeat until complete, escalated, or budgeted out. Without an LLM key, a state-driven fallback runs each applicable tool once (dev/staging only).

## Architecture

```mermaid
flowchart TB
    subgraph UI["Web UI"]
        DASH["Dashboard · Campaigns · Leads · Approvals · Activity"]
    end

    subgraph APP["Agent SDR App (Next.js)"]
        API["API Routes"]
        ORCH["Orchestrator — agentic decision loop"]
        STATE["State Snapshot<br/>lead · campaign · sequence · history"]
        SELECT["Tool Selection<br/>LLM · permission-validated"]
        TOOLS["Tool Registry<br/>13 tools"]
        GUARD["Guardrails<br/>suppression · idempotency · approvals · budgets"]
    end

    subgraph JOBS["Background Processing"]
        REDIS[("Redis<br/>job queue")]
        WORKER["Worker<br/>job handlers"]
    end

    PG[("PostgreSQL<br/>Prisma · source of truth")]

    EXT["External Integrations<br/>LLM (OpenAI, Anthropic) · Email (Resend, SendGrid, Postmark, SES, SMTP)<br/>CRM (HubSpot, Salesforce) · Calendar (Google, Outlook)<br/>Prospecting (Apollo, Hunter, PDL) · Verification (NeverBounce, Hunter)"]

    DASH --> API --> ORCH
    ORCH --> STATE --> SELECT --> TOOLS
    TOOLS --> GUARD
    TOOLS --> REDIS
    REDIS --> WORKER
    ORCH --> PG
    WORKER --> PG
    TOOLS --> EXT
    WORKER --> EXT
```

## Quickstart (Docker — recommended)

Docker is the easiest way to run the complete Agent SDR stack locally. You only
need **Docker** — no Node.js, npm, Postgres, or Redis on your machine. One command
starts all four services:

```mermaid
flowchart TB
    subgraph COMPOSE["Docker Compose"]
        APP["app<br/>Agent SDR · Next.js<br/>:3000"]
        WORKER["worker<br/>background jobs"]
        PG[("postgres<br/>PostgreSQL 16<br/>persistent volume")]
        REDIS[("redis<br/>Redis 7<br/>job queues")]
    end

    APP -->|migrations · queries| PG
    APP -->|enqueue jobs| REDIS
    REDIS -->|consume| WORKER
    WORKER -->|results · usage| PG
```

```text
Agent SDR app (Next.js, :3000) + worker + PostgreSQL 16 + Redis 7
```

```bash
git clone <your-fork-url> && cd agent-sdr
cp .env.example .env        # works as-is: console email + dev seed, zero API keys needed
docker compose up --build
```

That's it. The `app` container waits for healthy Postgres/Redis, applies migrations
automatically, seeds the demo workspace (idempotent), then serves the app; the
`worker` container starts once the app is healthy.

Open http://localhost:3000 — you'll be redirected to the login page.

### Local demo account

When `SEED_DEMO_USER=true` (the default in `.env.example`), a demo account is created:

| Field | Value |
|---|---|
| Email | `demo@agent-sdr.local` |
| Password | `demo-password-123` |

> **Local demo account — development only.** These credentials are created solely for
> local Docker development. Set `SEED_DEMO_USER=false` in production. Never use these
> credentials outside your local machine.

The demo account owns a workspace with a sample campaign and a few leads so you can
explore the dashboard, approvals, and agent activity immediately.

To create your own account instead, visit `/signup` — new accounts are logged in
automatically and land on the dashboard.

Useful container commands (no host Node.js required):

```bash
docker compose ps                                   # service health
docker compose logs -f app worker                   # logs
docker compose exec app npx prisma migrate deploy   # migrations (also automatic on boot)
docker compose exec app npm run db:seed             # seed (also automatic, idempotent)
docker compose exec app npm test                   # test suite inside Docker
docker compose down                                 # stop (data kept in pgdata volume)
docker compose down -v                              # full reset (deletes all local data)
```

## Native development (optional)

For day-to-day code changes with hot reload, run the app on your host (Node ≥ 20)
against containerized Postgres/Redis:

```bash
docker compose up -d postgres redis   # infra only
npm install
# point .env at localhost: DATABASE_URL=...@localhost:5433/..., REDIS_URL=redis://localhost:6379
npx prisma migrate dev && npm run db:seed
npm run dev     # app with hot reload → http://localhost:3000
npm run worker  # background jobs, separate terminal
```

## Configuration

All settings live in `.env` (see `.env.example` for the full annotated list): database/Redis URLs, `AUTH_SECRET` + `ENCRYPTION_KEY`, one LLM key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`), email provider + optional fallback chain, prospecting/enrichment/CRM/calendar keys, sending limits and approval defaults. Per-workspace model routing lives in the `model_configs` table; per-workspace provider credentials can be stored via encrypted connections.

### LLM providers

| Provider | Env var | Notes |
|---|---|---|
| **OpenAI** | `OPENAI_API_KEY` | Direct API. Native function-calling for agent tool selection. |
| **Anthropic** | `ANTHROPIC_API_KEY` | Direct API. JSON-mode structured output. |
| **DeepSeek** | `DEEPSEEK_API_KEY` | OpenAI-compatible. Inherits native function-calling. |
| **OpenRouter** | `OPENROUTER_API_KEY` | OpenAI-compatible gateway. Inherits native function-calling. Optional `OPENROUTER_HTTP_REFERER` / `OPENROUTER_X_TITLE` headers. |

Set `LLM_PROVIDER` to one of `openai|anthropic|deepseek|openrouter`. Per-task model routing is configured in the `model_configs` database table (provider + model + priority), so different workspaces or tasks can use different providers without code changes. OpenRouter routes to underlying models — the model ID you configure is passed through to OpenRouter's gateway.

## Project layout

| Path | What lives there |
|---|---|
| `src/app` | Next.js UI (dashboard, campaigns, leads, approvals, activity, settings) + API routes |
| `src/server/agents/orchestrator.ts` | Agent loop + 13-tool registry |
| `src/lib` | Provider abstractions (LLM, email, CRM, calendar, prospecting), policy/guardrails, scoring, knowledge/RAG, queue, auth, crypto |
| `prisma/` | Relational schema (~40 models), migrations, seed |
| `workers/` | Background job handlers + Redis consumer |
| `tests/` + `eval/` | Unit, integration, and agent-loop tests; unsupported-claim evals |
| `staging/` | End-to-end staging harness (`staging/e2e.ts`) + provider contract checks |
| `docs/` | Runbooks: migration, workers, deployment, testing |
| `docker/` | Container entrypoint (migrations, seeding, secrets) |
| `infra/terraform/` | Minimal AWS (RDS + ElastiCache + secrets + logs) |

## Testing

```bash
npm run typecheck   # strict tsc — the static gate (no lint script; Next 14 lint is deprecated)
npm test            # vitest: unit + integration (DB-backed tests skip gracefully without TEST_DATABASE_URL)
npm run eval        # deterministic evals: unsupported claims must fail, grounded copy must pass
npm run build       # production build must succeed
```

With a live DB: `TEST_DATABASE_URL="postgresql://sdr:sdr@localhost:5433/sdr" npm test` runs the full suite including the agent-loop tests (dynamic tool selection, budgets, resume, guardrails).

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). TL;DR: keep LLM reasoning and deterministic enforcement separated, put secrets only in `.env`, add tests with behavior changes, and run `typecheck` + `test` + `build` before opening a PR (CI runs the same).

## Intended use cases

- Running real outbound campaigns with approval oversight.
- Researching how to build agentic systems with hard guardrails.
- Extending with new providers (email, CRM, calendar, data) behind the existing interfaces.
- Self-hosting outbound infrastructure instead of renting seats.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 James Ugbanu.
