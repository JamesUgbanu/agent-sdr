# Multi-stage image for Agent SDR.
# - deps: reproducible install from lockfile
# - builder: Prisma client generation + Next.js production build
# - runner: slim runtime with full node_modules (worker runs on tsx, so dev
#   dependencies are intentionally kept; production-only pruning is left out
#   to keep one image for app + worker + tests).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time only: real DATABASE_URL is injected at runtime.
RUN DATABASE_URL="postgresql://sdr:sdr@localhost:5432/sdr" npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat wget
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/workers ./workers
COPY --from=builder /app/eval ./eval
COPY --from=builder /app/tests ./tests
COPY --from=builder /app/staging ./staging
COPY --from=builder /app/scripts ./scripts
COPY package.json next.config.mjs middleware.ts instrumentation.ts tsconfig.json vitest.config.ts ./
COPY docker ./docker
RUN chmod +x /app/docker/entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]
CMD ["app"]
