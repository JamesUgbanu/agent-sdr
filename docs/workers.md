# Workers runbook

## Start
In Docker (primary): the `worker` service starts automatically with `docker compose up`.
Natively: `npm run worker` — registers all handlers (`tsx workers/index.ts`).
With `REDIS_URL` set, jobs go through Redis lists (`sdr:queue:<name>`, delayed via `sdr:delayed:<name>`);
without it, dispatch is in-process (dev/test). Run at least 1 worker per deployment; scale
horizontally — handlers are idempotent.

## Queues
prospecting, enrichment, qualification, personalization, outreach, reply, meeting,
conversation, followup, crm. Long work never blocks HTTP: API routes persist + enqueue.

## Retries
- Max 3 attempts by default (`maxAttempts` per enqueue).
- Exponential backoff + jitter: 2s, 4s, 8s… capped at 60s.
- Permanent errors (validation, auth, policy blocks, suppression, duplicates) are NOT retried.
- Non-idempotent sends reconcile provider status before any retry (see `sendEmail` tool).

## Dead letters
Failed jobs persist to `dead_letters` with attempts, last error, history, workspace.
Inspect: `GET /api/admin/dead-letters` (owner role). Retry: `POST /api/admin/dead-letters/:id/retry`.

## Monitoring / troubleshooting
- Agent activity SSE: `/activity` page; `agent_events` table; correlation IDs
  (campaign_id/lead_id/run_id) on every run.
- Stuck lead? Check `lead_sequence_state.nextRunAt` + `agent_runs.status=failed`.
- Duplicate email? Check `messages.idempotencyKey` uniqueness + provider status reconciliation.
