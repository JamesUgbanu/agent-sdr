import { describe, it, expect } from "vitest";
import { POST } from "../../src/app/api/webhooks/email/route";

function req(body: unknown, secret?: string) {
  return new Request("http://localhost/api/webhooks/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { "x-webhook-secret": secret } : {}) },
    body: JSON.stringify(body),
  });
}

describe("email webhook", () => {
  it("rejects bad secret with 401", async () => {
    process.env.EMAIL_WEBHOOK_SECRET = "s3cret";
    const r = await POST(req({ from: "a@x.com", body: "hi" }, "wrong"));
    expect(r.status).toBe(401);
    delete process.env.EMAIL_WEBHOOK_SECRET;
  });
  it("rejects invalid payload with 400", async () => {
    const r = await POST(req({ nope: true }));
    expect(r.status).toBe(400);
  });
});
