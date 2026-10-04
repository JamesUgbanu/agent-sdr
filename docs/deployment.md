# Deployment runbook

## Environment
Required: `DATABASE_URL`, `AUTH_SECRET` (≥32 chars), `ENCRYPTION_KEY` (≥32 chars).
At least one LLM key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`).
Email: `EMAIL_PROVIDER=resend|sendgrid|postmark|ses|smtp|console` + provider key;
optional `EMAIL_FALLBACK="sendgrid,postmark"` chain.
Optional: `REDIS_URL`, `HUBSPOT_TOKEN`/`SALESFORCE_*`, `GOOGLE_CALENDAR_TOKEN`/`OUTLOOK_TOKEN`,
`APOLLO_API_KEY`/`HUNTER_API_KEY`/`PDL_API_KEY`, `NEVERBOUNCE_API_KEY`,
`EMAIL_WEBHOOK_SECRET`, `SIGNUP_ENABLED=false` (to close self-serve signup).

## Database + app + workers (Docker — primary)
```bash
docker compose up --build   # app + worker + postgres + redis; migrates + seeds automatically
```
Manual equivalents inside containers (migrations/seeding also run on boot):
```bash
docker compose exec app npx prisma migrate deploy
docker compose exec app npm run db:seed
```
Native (non-Docker) alternative: `docker compose up -d postgres redis`, then
`npm install`, `npx prisma migrate deploy`, `npm run build && npm run start` (app)
and `npm run worker` in a second process. Terraform in `infra/terraform/` provisions
AWS RDS + ElastiCache + secrets + log group for cloud deploys.

## Auth
Auth.js credentials provider, JWT sessions, scrypt-hashed passwords. First user signs up
at `/signup` (gets a personal workspace as owner), then signs in at `/login`.
Set `SIGNUP_ENABLED=false` after creating admin users. API routes enforce
`requireMembership(workspaceId)`; webhooks use `EMAIL_WEBHOOK_SECRET`, never sessions.

## Webhooks
Point the email provider at `POST /api/webhooks/email` with header
`x-webhook-secret: $EMAIL_WEBHOOK_SECRET`. Handler validates → persists → enqueues → 200.

## Troubleshooting
- `Can't reach database server` / `Cannot connect to the Docker daemon`: start Docker Desktop
  (macOS: `open -a Docker`) and wait for it, then `docker compose up -d`. Volumes persist,
  so existing staging data survives restarts.
- Port conflict on 5432: this project maps Postgres to host port **5433** deliberately
  (see `docker-compose.yml`); keep `DATABASE_URL` in sync with it.
- `P1010 denied access on sdr.public`: you are talking to a different Postgres than the
  compose one — check `lsof -i :5433` and your `DATABASE_URL`.

## Production verification
1. `npm run typecheck && npm test && npm run eval`
2. Sign up → create campaign (POST /api/campaigns) → lead flows NEW→…→CONTACTED.
3. Send a test inbound email to the webhook → reply classified, sequence stops.
4. Check `/api/analytics` reflects every step; check `llm_usage` rows have real token counts.
