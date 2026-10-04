// Simple in-memory fixed-window rate limiter (swap for Redis in multi-instance deploys).
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now > h.reset) {
    // Opportunistic pruning keeps the map bounded on long-lived processes.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    }
    hits.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  h.n++;
  return h.n <= limit;
}
