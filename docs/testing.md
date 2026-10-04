# Testing runbook

## Suites
```bash
npm run typecheck     # tsc --noEmit (strict)
npm test              # vitest run — unit + integration (offline-safe)
npm run eval          # eval/run.ts — deterministic agent evals
npm run build         # production build must succeed
```
There is no lint script (Next 14's built-in lint is deprecated); `npm run typecheck` is the static gate.

## Unit (`tests/*.test.ts`)
scoring, state machine, guardrails (fabrication heuristics), suppression/terminal states,
working-hours gate, rate limiter, crypto round-trip, intent detection, knowledge
tokenizer/context builder, queue retryability/backoff/dedupe.

## Integration (`tests/integration/*.test.ts`)
- queue: failing handler → retries → dead-letter row path; idempotent enqueue dedupe;
  permanent errors go straight to DLQ.
- email: console channel send + getStatus; provider getStatus honesty (unknown, not invented).
- webhooks: 401 on bad secret, 400 on invalid payload, duplicate providerMessageId dedupes.
- auth: password hash/verify round-trip; session membership 403 for non-members.
- model routing: `resolveModel` falls back safely with no DB / no rows.
DB-backed lifecycle tests auto-skip without a live `TEST_DATABASE_URL`
(`tests/integration/db.test.ts` covers workspace isolation, campaign→lead lifecycle,
knowledge round-trip, conversation persistence, research-cache hits when live).

## Evals (`eval/run.ts`)
Hard-fail checks: unsupported pricing/funding claims flagged; evidence-backed copy passes.
Extend with labeled reply-classification and personalization datasets as volume grows.

## Provider tests
Real providers are exercised with test-mode credentials in staging (Resend/SendGrid
sandbox, HubSpot test portal). Without credentials, adapters throw explicit
"not configured" errors — never faked; CI covers the unavailable-state paths.
