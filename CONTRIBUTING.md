# Contributing to Agent SDR

Thanks for contributing. This project is [MIT licensed](LICENSE); by submitting a PR you agree your contributions will fall under the same license. This project has one architectural rule that matters more than any other:

> **LLMs decide; deterministic code enforces.** Keep model reasoning and safety-critical
> enforcement (auth, suppression, idempotency, approvals, opt-outs, limits, retries)
> in separate layers. Never let a prompt bypass a guardrail.

## Development workflow

1. Fork and clone. Docker is all you need to run the stack (see README Quickstart).
2. `cp .env.example .env && docker compose up --build`
3. For code changes with hot reload, use the native dev flow instead (Node ≥ 20):
   `docker compose up -d postgres redis && npm install`, point `.env` at
   `localhost:5433`/`localhost:6379`, `npx prisma migrate dev && npm run db:seed`,
   then `npm run dev` + `npm run worker` in separate terminals.
4. Create a branch: `git checkout -b feat/short-description`.

## Before opening a PR

```bash
npm run typecheck   # must pass (strict)
npm test            # must pass; add tests for behavior changes
npm run build       # must succeed
```

Live-DB tests: `TEST_DATABASE_URL="postgresql://sdr:sdr@localhost:5433/sdr" npm test`.
There is no lint script (Next 14's lint is deprecated); typecheck is the gate. CI (`.github/workflows/ci.yml`) runs install → generate → typecheck → test.

## PR guidelines

- **One concern per PR.** Provider additions stay behind the interfaces in `src/lib` — no provider-specific logic in agents or routes.
- **No secrets, ever.** Keys go in `.env` (gitignored). If you touch `.env.example`, use empty placeholders.
- **No fake completeness.** A feature is done when the workflow works end to end, not when an interface exists. External-credential gaps must be explicit errors, never mocked success.
- **Tests required** for: scoring/policy changes, state transitions, new tools, webhook handling, auth changes.
- **Docs:** update `docs/` runbooks when behavior, env vars, or operations change.
- Small PRs review fastest. For large architectural changes, open an issue first.

## Reporting issues

Include: what you ran (commands + Node/Docker versions), what you expected, what happened (logs), and your provider configuration (redact keys). Security issues: do not open a public issue — contact the maintainer privately.
