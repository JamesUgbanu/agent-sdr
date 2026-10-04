import { describe, it, expect } from "vitest";
import { stableArgs } from "../src/lib/tool-schema";
import { channelForProvider, parseFromAddress } from "../src/lib/email";
import { withApi } from "../src/lib/api";
import { ApprovalDecisionSchema as DecisionSchema } from "../src/lib/validation";

describe("stableArgs", () => {
  it("is order-insensitive including nested keys", () => {
    expect(stableArgs({ b: 1, a: 2 })).toBe(stableArgs({ a: 2, b: 1 }));
    expect(stableArgs({ a: { z: 1, y: 2 } })).toBe(stableArgs({ a: { y: 2, z: 1 } }));
  });
  it("distinguishes different nested values (no false identical-arg matches)", () => {
    expect(stableArgs({ a: { x: 1 } })).not.toBe(stableArgs({ a: { x: 2 } }));
    expect(stableArgs({ a: { x: 1 } })).not.toBe(stableArgs({ a: {} }));
  });
});

describe("email channel selection", () => {
  it("throws on unknown provider instead of silently dry-running", () => {
    expect(() => channelForProvider("resend-typo")).toThrow(/Unknown email provider/);
    expect(() => channelForProvider("console")).not.toThrow();
  });
  it("parses bare address out of display-name FROM", () => {
    expect(parseFromAddress("SDR <sdr@example.com>")).toBe("sdr@example.com");
    expect(parseFromAddress("sdr@example.com")).toBe("sdr@example.com");
  });
});

describe("approval decision validation", () => {
  it("rejects unknown decisions", () => {
    expect(DecisionSchema.safeParse("approve").success).toBe(false);
    expect(DecisionSchema.safeParse("approved").success).toBe(true);
  });
});

describe("withApi", () => {
  it("maps malformed JSON to 400", async () => {
    const h = withApi(async (): Promise<Response> => {
      JSON.parse("{bad json");
      throw new Error("unreachable");
    });
    const r = await h();
    expect(r.status).toBe(400);
  });
});
