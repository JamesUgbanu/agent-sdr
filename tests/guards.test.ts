import { describe, it, expect } from "vitest";
import { TERMINAL_STATUSES } from "../src/lib/policy";
import { canTransition } from "../src/lib/state-machine";
import { withinWorkingHours } from "../src/lib/policy";
import { rateLimit } from "../src/lib/rate-limit";

// scoring re-exports guardrail constants for policy tests (kept dependency-free)
void TERMINAL_STATUSES;

describe("suppression & terminal states", () => {
  it("terminal states have no outbound transitions", () => {
    for (const s of ["NOT_INTERESTED", "UNSUBSCRIBED", "BOUNCED", "DISQUALIFIED", "DO_NOT_CONTACT"]) {
      expect(canTransition(s, "CONTACTED")).toBe(false);
      expect(canTransition(s, "FOLLOW_UP")).toBe(false);
    }
  });
  it("reply stops the sequence (no CONTACTED after REPLIED)", () => {
    expect(canTransition("REPLIED", "FOLLOW_UP")).toBe(false);
    expect(canTransition("REPLIED", "MEETING_REQUESTED")).toBe(true);
  });
});

describe("working hours gate", () => {
  it("allows mid-day UTC", () => {
    const noon = new Date("2026-01-05T12:00:00Z");
    expect(withinWorkingHours("UTC", "09:00", "17:00", noon)).toBe(true);
  });
  it("blocks night sends", () => {
    const night = new Date("2026-01-05T02:00:00Z");
    expect(withinWorkingHours("UTC", "09:00", "17:00", night)).toBe(false);
  });
});

describe("rate limit", () => {
  it("caps bursts", () => {
    const k = `test-${Date.now()}`;
    for (let i = 0; i < 5; i++) expect(rateLimit(k, 5, 60_000)).toBe(true);
    expect(rateLimit(k, 5, 60_000)).toBe(false);
  });
});
