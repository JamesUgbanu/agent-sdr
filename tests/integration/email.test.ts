import { describe, it, expect } from "vitest";
import { channelForProvider, sendWithFallback } from "../../src/lib/email";

describe("email providers", () => {
  it("console channel sends and reports status honestly", async () => {
    const ch = channelForProvider("console");
    const r = await ch.send({ to: "a@example.com", subject: "s", body: "b", idempotencyKey: "k1" });
    expect(r.status).toBe("sent");
    const st = await ch.getStatus(r.providerMessageId);
    expect(st.status).toBe("sent");
  });
  it("unconfigured providers throw explicitly instead of faking", async () => {
    const ch = channelForProvider("sendgrid");
    await expect(ch.send({ to: "a@example.com", subject: "s", body: "b", idempotencyKey: "k2" })).rejects.toThrow(/not configured/i);
  });
  it("sendgrid getStatus reports unknown without webhook history (never invented)", async () => {
    const ch = channelForProvider("sendgrid");
    const st = await ch.getStatus("nonexistent-id");
    expect(st.status).toBe("unknown");
  });
  it("sendWithFallback delivers via console chain", async () => {
    process.env.EMAIL_PROVIDER = "console";
    const r = await sendWithFallback({ to: "a@example.com", subject: "s", body: "b", idempotencyKey: `k-${Date.now()}` }, []);
    expect(r.status).toBe("sent");
    expect(r.provider).toBe("console");
  });
});
