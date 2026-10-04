#!/bin/sh
# Container entrypoint: wait for dependencies, apply migrations, optionally
# seed, generate throwaway dev secrets when placeholders are present, then
# run the requested process (app | worker).
set -e

wait_for_tcp() {
  host="$1"; port="$2"; name="$3"
  echo "[entrypoint] waiting for $name ($host:$port)..."
  node -e "
const net = require('net');
const deadline = Date.now() + 90000;
(function tryOnce() {
  const s = net.connect({ host: '$host', port: $port }, () => { s.end(); process.exit(0); });
  s.on('error', () => { s.destroy(); setTimeout(() => Date.now() > deadline ? process.exit(1) : tryOnce(), 1000); });
})();
"
  echo "[entrypoint] $name reachable"
}

gen_secret_if_placeholder() {
  varname="$1"
  eval "val=\$$varname"
  case "$val" in
    *change-me*|"")
      gen=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
      export "$varname=$gen"
      echo "[entrypoint] WARNING: generated ephemeral $varname for this container (set a real value in .env for anything shared)"
      ;;
  esac
}

MODE="${1:-app}"

if [ "$MODE" = "app" ] || [ "$MODE" = "worker" ]; then
  wait_for_tcp "${POSTGRES_HOST:-postgres}" "${POSTGRES_PORT:-5432}" "postgres"
  wait_for_tcp "${REDIS_HOST:-redis}" "${REDIS_PORT:-6379}" "redis"
fi

if [ "$MODE" = "app" ]; then
  gen_secret_if_placeholder AUTH_SECRET
  gen_secret_if_placeholder ENCRYPTION_KEY
  echo "[entrypoint] applying database migrations..."
  npx prisma migrate deploy
  if [ "${SEED_ON_BOOT:-true}" = "true" ]; then
    echo "[entrypoint] seeding (idempotent)..."
    npm run db:seed
  fi
  echo "[entrypoint] starting app..."
  exec npm run start
fi

if [ "$MODE" = "worker" ]; then
  gen_secret_if_placeholder AUTH_SECRET
  gen_secret_if_placeholder ENCRYPTION_KEY
  echo "[entrypoint] starting worker..."
  exec npm run worker
fi

echo "unknown mode: $MODE (use app|worker)" >&2
exit 1
