import { db, J } from "./db";

// Queue: Redis-backed in prod, in-memory fallback for dev/test.
// Reliability: exponential backoff + jitter, max attempts, dead-letter persistence,
// provider-aware retryability. Non-idempotent ops must reconcile before retry —
// handlers own that contract; the queue never duplicates dispatches for one enqueue.
export type JobHandler = (payload: { [k: string]: unknown }) => Promise<void>;
export interface EnqueueOpts {
  delayMs?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  workspaceId?: string;
}

const handlers = new Map<string, JobHandler>();
const seen = new Set<string>(); // in-memory dedupe for idempotency keys (process-local best effort; DB-level idempotency is authoritative)

// Shared Redis client: one connection per process instead of connect/disconnect per enqueue.
// Keyed by URL so env changes (e.g. tests disabling Redis) take effect.
let sharedRedis: { lpush(k: string, v: string): Promise<unknown>; zadd(k: string, s: number, v: string): Promise<unknown> } | null = null;
let sharedUrl = "";
async function redis() {
  const url = process.env.REDIS_URL ?? "";
  if (!url) {
    sharedRedis = null;
    sharedUrl = "";
    return null;
  }
  if (!sharedRedis || sharedUrl !== url) {
    const { default: Redis } = await import("ioredis");
    const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await r.connect().catch(() => undefined);
    sharedRedis = r as unknown as NonNullable<typeof sharedRedis>;
    sharedUrl = url;
  }
  return sharedRedis;
}

export function registerHandler(name: string, fn: JobHandler) {
  handlers.set(name, fn);
}

export function isRetryableError(e: unknown): boolean {
  const s = String(e);
  // Permanent: validation, auth, policy blocks, not-found. Never retry these.
  if (/not found|unauthorized|forbidden|invalid|blocked|limit reached|suppressed|terminal|duplicate|already|unique constraint|already exists/i.test(s)) return false;
  return true;
}

export function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 500); // jitter
}

async function deadLetter(queue: string, payload: unknown, attempts: number, lastError: string, workspaceId?: string) {
  try {
    await db.deadLetter.create({
      data: {
        queue, payload: J(payload ?? {}), attempts, lastError,
        workspaceId, history: J([{ at: new Date().toISOString(), error: lastError }]),
        status: "open",
      },
    });
  } catch { /* never crash on observability */ }
  console.error(`[queue:${queue}] dead-lettered after ${attempts} attempts: ${lastError}`);
}

async function dispatch(name: string, payload: { [k: string]: unknown }, attempt: number, maxAttempts: number, workspaceId?: string): Promise<void> {
  const fn = handlers.get(name);
  if (!fn) {
    await deadLetter(name, payload, attempt, `no handler registered`, workspaceId);
    return;
  }
  try {
    await fn(payload);
  } catch (e) {
    const err = String(e);
    if (!isRetryableError(e) || attempt >= maxAttempts) {
      await deadLetter(name, payload, attempt, err, workspaceId);
      return;
    }
    const wait = backoffMs(attempt);
    console.warn(`[queue:${name}] attempt ${attempt} failed, retrying in ${wait}ms: ${err}`);
    setTimeout(() => dispatch(name, payload, attempt + 1, maxAttempts, workspaceId).catch(() => undefined), wait);
  }
}

export async function enqueue(name: string, payload: unknown, opts?: EnqueueOpts) {
  const body = (payload ?? {}) as { [k: string]: unknown };
  if (opts?.idempotencyKey) {
    if (seen.has(opts.idempotencyKey)) return; // duplicate enqueue suppressed
    seen.add(opts.idempotencyKey);
    if (seen.size > 10_000) seen.clear();
  }
  const maxAttempts = opts?.maxAttempts ?? 3;
  if (process.env.REDIS_URL) {
    try {
      const r = await redis();
      if (r) {
        const msg = JSON.stringify({ payload: body, attempt: 1, maxAttempts, workspaceId: opts?.workspaceId });
        if (opts?.delayMs) {
          await r.zadd(`sdr:delayed:${name}`, Date.now() + opts.delayMs, msg);
        } else {
          await r.lpush(`sdr:queue:${name}`, msg);
        }
        return;
      }
    } catch {
      // Redis write failed: drop the stale client so the next call reconnects,
      // then fall through to inline dispatch below. A job is never silently lost.
      try {
        const stale = sharedRedis as unknown as { disconnect?: () => void } | null;
        stale?.disconnect?.();
      } catch { /* ignore */ }
      sharedRedis = null;
    }
  }
  const run = () => dispatch(name, body, 1, maxAttempts, opts?.workspaceId).catch(() => undefined);
  if (opts?.delayMs) setTimeout(run, Math.min(opts.delayMs, 2_147_483_647));
  else queueMicrotask(run);
}

// Consumed by the worker process for Redis-backed deployments.
export async function processRedisMessage(name: string, raw: string): Promise<void> {
  let msg: { payload?: { [k: string]: unknown }; attempt?: number; maxAttempts?: number; workspaceId?: string };
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    // Unparseable payload would otherwise vanish in the consumer catch-all.
    await deadLetter(name, { raw: String(raw).slice(0, 2000) }, 1, `unparseable queue payload: ${String(e).slice(0, 200)}`);
    return;
  }
  await dispatch(name, msg.payload ?? {}, msg.attempt ?? 1, msg.maxAttempts ?? 3, msg.workspaceId);
}

// Admin: list + retry dead letters.
export async function listDeadLetters(status = "open", take = 50, workspaceId?: string) {
  return db.deadLetter.findMany({
    where: { status, ...(workspaceId ? { workspaceId } : {}) },
    orderBy: { createdAt: "desc" }, take,
  });
}
export async function retryDeadLetter(id: string) {
  const dl = await db.deadLetter.findUnique({ where: { id } });
  if (!dl) throw new Error("dead letter not found");
  await db.deadLetter.update({ where: { id }, data: { status: "retried" } });
  await enqueue(dl.queue, dl.payload, { workspaceId: dl.workspaceId ?? undefined, idempotencyKey: `dl-retry-${id}` });
  return { requeued: true };
}
