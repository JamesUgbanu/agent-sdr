import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { verifySvixSignature, webhookAuth } from "../src/lib/webhook-auth";

function signed(secretB64: string, msgId: string, ts: string, body: string) {
  const sig = createHmac("sha256", Buffer.from(secretB64, "base64")).update(`${msgId}.${ts}.${body}`, "utf8").digest("base64");
  return `v1,${sig}`;
}

describe("svix verification", () => {
  const secret = randomBytes(32).toString("base64");
  const msgId = "msg_test123";
  const body = JSON.stringify({ provider: "resend", providerMessageId: "x", event: "delivered" });
  const ts = String(Math.floor(Date.now() / 1000));

  it("accepts a valid signature", () => {
    expect(verifySvixSignature({ secret, msgId, timestamp: ts, signatureHeader: signed(secret, msgId, ts, body), rawBody: body })).toBe(true);
  });
  it("rejects tampered bodies", () => {
    expect(verifySvixSignature({ secret, msgId, timestamp: ts, signatureHeader: signed(secret, msgId, ts, body), rawBody: body + "x" })).toBe(false);
  });
  it("rejects wrong secrets", () => {
    const other = randomBytes(32).toString("base64");
    expect(verifySvixSignature({ secret: other, msgId, timestamp: ts, signatureHeader: signed(secret, msgId, ts, body), rawBody: body })).toBe(false);
  });
  it("rejects stale timestamps (replay window)", () => {
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(verifySvixSignature({ secret, msgId, timestamp: old, signatureHeader: signed(secret, msgId, old, body), rawBody: body })).toBe(false);
  });
  it("rejects missing headers", () => {
    expect(verifySvixSignature({ secret, msgId: null, timestamp: ts, signatureHeader: null, rawBody: body })).toBe(false);
  });
  it("accepts whsec_-prefixed secrets", () => {
    const prefixed = `whsec_${secret}`;
    expect(verifySvixSignature({ secret: prefixed, msgId, timestamp: ts, signatureHeader: signed(secret, msgId, ts, body), rawBody: body })).toBe(true);
  });
});

describe("webhook shared-secret gate", () => {
  const OLD_ENV = { ...process.env };
  const restore = () => {
    delete process.env.EMAIL_WEBHOOK_SECRET;
    delete process.env.NODE_ENV_TEST_MARKER;
    for (const [k, v] of Object.entries(OLD_ENV)) process.env[k] = v;
  };
  it("allows open mode in non-production without a secret", async () => {
    delete process.env.EMAIL_WEBHOOK_SECRET;
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    await expect(webhookAuth(new Request("http://x", { headers: {} }), "test")).resolves.toBeUndefined();
    (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    restore();
  });
  it("rejects missing secret in production", async () => {
    delete process.env.EMAIL_WEBHOOK_SECRET;
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    await expect(webhookAuth(new Request("http://x", { headers: {} }), "test")).rejects.toMatchObject({ status: 401 });
    (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    restore();
  });
  it("rejects wrong secret when configured", async () => {
    process.env.EMAIL_WEBHOOK_SECRET = "correct-secret";
    await expect(webhookAuth(new Request("http://x", { headers: { "x-webhook-secret": "wrong" } }), "test")).rejects.toMatchObject({ status: 401 });
    restore();
  });
  it("accepts the correct secret", async () => {
    process.env.EMAIL_WEBHOOK_SECRET = "correct-secret";
    await expect(webhookAuth(new Request("http://x", { headers: { "x-webhook-secret": "correct-secret" } }), "test")).resolves.toBeUndefined();
    restore();
  });
});
