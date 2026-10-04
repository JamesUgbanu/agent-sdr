import { describe, it, expect } from "vitest";
import { canTransition } from "../src/lib/state-machine";
import { assertNoFabrication } from "../src/lib/policy";

describe("state machine", () => {
  it("allows legal transitions", () => {
    expect(canTransition("NEW", "RESEARCHING")).toBe(true);
    expect(canTransition("REPLIED", "MEETING_REQUESTED")).toBe(true);
  });
  it("blocks illegal jumps and terminal exits", () => {
    expect(canTransition("NEW", "MEETING_BOOKED")).toBe(false);
    expect(canTransition("UNSUBSCRIBED", "CONTACTED")).toBe(false);
  });
});

describe("guardrails", () => {
  it("rejects fabricated pricing/hiring claims without evidence", () => {
    expect(() => assertNoFabrication("Our pricing is $500/mo", [])).toThrow();
  });
  it("passes evidence-backed copy", () => {
    expect(() => assertNoFabrication("Hi — quick idea for your team.", ["careers page lists 3 roles"])).not.toThrow();
  });
});

describe("reply classification rules", () => {
  it("unsubscribe pattern", () => {
    expect(/unsubscribe|remove me/i.test("Please remove me from your list")).toBe(true);
  });
  it("ooo pattern", () => {
    expect(/out of office|ooo/i.test("I am out of office")).toBe(true);
  });
});
