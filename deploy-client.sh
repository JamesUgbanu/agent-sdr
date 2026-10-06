#!/bin/sh
# Per-client isolated deployment: one client = one Compose project with its
# own app + worker + Postgres + Redis + env file.
#
#   ./deploy-client.sh <client> [--app-port N] [--pg-port N] [--redis-port N] [--no-seed-demo]
#
# Fails fast on any error. Safe to re-run (idempotent; never drops volumes).
# Secrets live in .env.<client> (gitignored) — never committed, never logged.
set -eu

CLIENT="${1:-}"
APP_PORT="3000"; PG_PORT="5433"; REDIS_PORT="6379"; SEED_DEMO="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --app-port=*) APP_PORT="${1#*=}"; shift ;;
    --app-port) APP_PORT="${2:?--app-port needs a value}"; shift 2 ;;
    --pg-port=*) PG_PORT="${1#*=}"; shift ;;
    --pg-port) PG_PORT="${2:?--pg-port needs a value}"; shift 2 ;;
    --redis-port=*) REDIS_PORT="${1#*=}"; shift ;;
    --redis-port) REDIS_PORT="${2:?--redis-port needs a value}"; shift 2 ;;
    --no-seed-demo) SEED_DEMO="false"; shift ;;
    --dev) SEED_DEMO="true"; shift ;;
    --help|-h) echo "usage: $0 <client> [--app-port N] [--pg-port N] [--redis-port N] [--no-seed-demo] [--dev]"; exit 0 ;;
    *) shift ;;
  esac
done

fail() { echo "[deploy:$CLIENT] ERROR: $1" >&2; exit 1; }
ok() { echo "[deploy:$CLIENT] OK: $1"; }

case "$CLIENT" in
  ""|*[!a-z0-9-]*) fail "client name required: lowercase letters, digits, hyphens only" ;;
esac
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose is not available"

PROJECT="agent-sdr-$CLIENT"
ENV_FILE=".env.$CLIENT"

if [ ! -f "$ENV_FILE" ]; then
  [ -f .env.example ] || fail ".env.example missing — run from the repository root"
  cp .env.example "$ENV_FILE"
  # Generate real secrets where placeholders exist (never commit this file).
  for key in AUTH_SECRET ENCRYPTION_KEY; do
    if grep -q "^${key}=\"change-me" "$ENV_FILE"; then
      gen=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
      # portable in-place edit (BSD + GNU sed)
      tmp="${ENV_FILE}.tmp"; sed "s|^${key}=.*|${key}=\"${gen}\"|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
    fi
  done
  ok "created $ENV_FILE (review provider keys before production use)"
else
  ok "using existing $ENV_FILE"
fi

# Demo data is for local evaluation, never for paying clients (default off;
# pass --dev for a demo-seeded evaluation stack).
tmp="${ENV_FILE}.tmp"
sed "s|^SEED_DEMO_USER=.*|SEED_DEMO_USER=\"${SEED_DEMO}\"|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"

for p in APP_PORT PG_PORT REDIS_PORT; do
  eval "v=\$$p"
  case "$v" in ''|*[!0-9]*) fail "$p must be a numeric port (got '$v')" ;; esac
done

# Production guardrails on the env file itself (fail fast, before any build).
# Webhook receivers must be authenticated in any non-dev deployment.
if ! grep -q '^EMAIL_WEBHOOK_SECRET="[^"]\+"' "$ENV_FILE"; then
  fail "EMAIL_WEBHOOK_SECRET is empty in $ENV_FILE — set a generated secret (refusing insecure webhooks)"
fi
for key in AUTH_SECRET ENCRYPTION_KEY; do
  if grep -q "^${key}=\"change-me" "$ENV_FILE"; then
    fail "$key still has the dev placeholder in $ENV_FILE — generate a real secret"
  fi
done

export COMPOSE_PROJECT_NAME="$PROJECT"
export APP_PORT PG_PORT REDIS_PORT
export CLIENT_ENV_FILE="$ENV_FILE"
if [ "$APP_PORT" != "3000" ]; then
  export NEXTAUTH_URL="http://localhost:${APP_PORT}"
fi

echo "[deploy:$CLIENT] validating configuration..."
( set -a; . "./$ENV_FILE"; set +a; npx tsx scripts/check-config.ts --strict ) || fail "configuration check failed (see errors above)"
SEED_DEMO_USER="$SEED_DEMO" COMPOSE_PROJECT_NAME="$PROJECT" APP_PORT="$APP_PORT" PG_PORT="$PG_PORT" REDIS_PORT="$REDIS_PORT" \
  docker compose --env-file "$ENV_FILE" -p "$PROJECT" up --build -d || fail "compose up failed"

wait_healthy() {
  svc="$1"; tries=0
  while [ "$tries" -lt 40 ]; do
    st=$(docker inspect --format='{{.State.Health.Status}}' "$PROJECT-$svc-1" 2>/dev/null || echo "missing")
    [ "$st" = "healthy" ] && { ok "$svc healthy"; return 0; }
    tries=$((tries + 1)); sleep 5
  done
  fail "$svc did not become healthy"
}
wait_healthy postgres
wait_healthy redis
wait_healthy app
wait_healthy worker

echo "[deploy:$CLIENT] running migrations..."
docker compose --env-file "$ENV_FILE" -p "$PROJECT" exec -T app npx prisma migrate deploy || fail "migrations failed"

echo "[deploy:$CLIENT] verifying services..."
APP_URL="http://localhost:${APP_PORT}"
health=$(curl -sf "$APP_URL/api/health" || echo "DOWN")
echo "$health" | grep -q '"database":true' || fail "app health check failed: $health"
ok "app serving at $APP_URL (database: true)"
docker compose --env-file "$ENV_FILE" -p "$PROJECT" exec -T postgres pg_isready -U sdr -d sdr >/dev/null || fail "postgres not accepting connections"
ok "postgres accepting connections"
docker compose --env-file "$ENV_FILE" -p "$PROJECT" exec -T redis redis-cli ping | grep -q PONG || fail "redis not responding"
ok "redis responding"

echo ""
echo "[deploy:$CLIENT] SUCCESS — isolated deployment is live:"
echo "  app:      $APP_URL"
echo "  postgres: localhost:$PG_PORT (volume: ${PROJECT}_pgdata)"
echo "  redis:    localhost:$REDIS_PORT"
echo "  env file: $ENV_FILE (not in git — back it up securely)"
