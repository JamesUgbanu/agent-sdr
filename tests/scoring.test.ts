import { describe, it, expect } from "vitest";
import { scoreLead } from "../src/lib/scoring";

describe("scoring", () => {
  it("computes explained weighted factors, not a black box", () => {
    const r = scoreLead(
      { companyMatch: 1, roleMatch: 1, geoMatch: 1, intentMatch: 1, signalStrength: 1, dataConfidence: 1 },
      { companyFit: 25, roleFit: 20, geo: 10, intent: 20, signal: 15, dataConfidence: 10 },
    );
    expect(r.score).toBe(100);
    expect(r.factors.companyFit).toBe(25);
  });
  it("low fit scores low", () => {
    const r = scoreLead(
      { companyMatch: 0, roleMatch: 0, geoMatch: 0, intentMatch: 0, signalStrength: 0, dataConfidence: 0 },
      { companyFit: 25, roleFit: 20, geo: 10, intent: 20, signal: 15, dataConfidence: 10 },
    );
    expect(r.score).toBe(0);
  });
});
