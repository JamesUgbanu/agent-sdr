import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../../src/lib/password";
import { encryptSecret, decryptSecret } from "../../src/lib/crypto";
import { tokenize, buildAuthorizedContext } from "../../src/lib/knowledge";
import { detectIntent } from "../../src/lib/conversation";
import { resolveModel } from "../../src/lib/models";
import { withApi } from "../../src/lib/api";

describe("auth primitives", () => {
  it("password round-trips and rejects wrong passwords", () => {
    const h = hashPassword("supersecret-password");
    expect(verifyPassword("supersecret-password", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });
  it("secret encryption round-trips", () => {
    process.env.ENCRYPTION_KEY = "test-encryption-key-that-is-long-enough-32";
    const enc = encryptSecret('{"token":"abc"}');
    expect(decryptSecret(enc)).toBe('{"token":"abc"}');
  });
  it("withApi maps auth errors to 401/403", async () => {
    const h = withApi(async () => { throw Object.assign(new Error("nope"), { status: 403 }); });
    const r = await h();
    expect(r.status).toBe(403);
  });
});

describe("knowledge + intent (pure)", () => {
  it("tokenizes queries for retrieval", () => {
    expect(tokenize("How much does pricing cost?")).toContain("pricing");
    expect(tokenize("the and or")).toEqual([]);
  });
  it("builds attributed context", () => {
    const ctx = buildAuthorizedContext([
      { chunkId: "c1", documentTitle: "Pricing", source: "pricing", heading: null, content: "Pro is $99/mo", score: 0.5 },
    ]);
    expect(ctx).toContain("[1]");
    expect(ctx).toContain("Pro is $99/mo");
    expect(buildAuthorizedContext([])).toBe("");
  });
  it("detects opt-out, pricing, meeting intents", () => {
    expect(detectIntent("please remove me").intent).toBe("opt_out");
    expect(detectIntent("how much does it cost?").intent).toBe("pricing_question");
    expect(detectIntent("book a meeting tuesday").intent).toBe("meeting_request");
    expect(detectIntent("hello there friend").intent).toBe("unclear");
  });
});

describe("model routing", () => {
  it("falls back safely with no DB rows", async () => {
    const m = await resolveModel("personalization");
    expect(m.model.length).toBeGreaterThan(0);
    expect(m.provider.length).toBeGreaterThan(0);
  });
});
