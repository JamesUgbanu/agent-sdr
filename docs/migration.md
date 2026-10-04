# Migration runbook

## Local
```bash
docker compose up -d                       # postgres:16 + redis:7
DATABASE_URL="postgresql://sdr:sdr@localhost:5433/sdr" npx prisma migrate dev --name <change>
```

## Production
```bash
npx prisma migrate deploy                  # applies pending migrations, no dev artifacts
DATABASE_URL="..." npx prisma validate     # sanity check before deploy
```
The Docker image runs `prisma migrate deploy` on boot before `next start`.

## Safety
- Migrations are additive by policy: new tables/columns are nullable or have defaults.
- Destructive changes require a two-step deploy (add nullable → backfill → constrain).
- `prisma/seed.ts` creates the demo workspace only; never run with production data.
- Rollback: `prisma migrate resolve --rolled-back <migration>` then redeploy the previous image.
- New models in this release: Knowledge*, Conversation*, ResearchCache, LlmUsage,
  EmailVerification, CrmSync, DeadLetter; User.passwordHash; ModelConfig.(enabled,priority,fallbackModel).
