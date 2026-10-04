import { describe, it, expect, beforeEach } from "vitest";
import { registerHandler, enqueue, isRetryableError, backoffMs } from "../../src/lib/queue";

// These tests assert in-process dispatch semantics; Redis-backed dispatch is
// covered by the staging E2E (real worker + consumer).
beforeEach(() => { delete process.env.REDIS_URL; });

describe("queue reliability", () => {
  it("classifies retryable vs permanent errors", () => {
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("timeout"))).toBe(true);
    expect(isRetryableError(new Error("unauthorized"))).toBe(false);
    expect(isRetryableError(new Error("Send blocked: suppressed:unsubscribed"))).toBe(false);
    expect(isRetryableError(new Error("daily-send-limit reached"))).toBe(false);
    expect(isRetryableError(new Error("lead not found"))).toBe(false);
  });
  it("backoff grows exponentially within cap", () => {
    const a = backoffMs(1), b = backoffMs(2), c = backoffMs(10);
    expect(a).toBeGreaterThanOrEqual(2000);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeLessThanOrEqual(60500);
  });
  it("deduplicates enqueues with the same idempotency key", async () => {
    let runs = 0;
    registerHandler("test-dedupe", async () => { runs++; });
    const key = `k-${Date.now()}`;
    await enqueue("test-dedupe", {}, { idempotencyKey: key });
    await enqueue("test-dedupe", {}, { idempotencyKey: key });
    await new Promise((r) => setTimeout(r, 100));
    expect(runs).toBe(1);
  });
  it("permanent errors do not retry (single attempt)", async () => {
    let runs = 0;
    registerHandler("test-perm", async () => { runs++; throw new Error("Send blocked: terminal:UNSUBSCRIBED"); });
    await enqueue("test-perm", {}, { maxAttempts: 5 });
    await new Promise((r) => setTimeout(r, 300));
    expect(runs).toBe(1);
  });
  it("transient errors retry up to maxAttempts", async () => {
    let runs = 0;
    registerHandler("test-retry", async () => { runs++; throw new Error("fetch failed"); });
    await enqueue("test-retry", {}, { maxAttempts: 2 });
    await new Promise((r) => setTimeout(r, 3500));
    expect(runs).toBe(2);
  }, 10000);
});
