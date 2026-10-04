// Deterministic evals: unsupported-claim detection is a hard failure.
import { assertNoFabrication } from "../src/lib/policy";
import { scoreLead } from "../src/lib/scoring";

const cases = [
  { body: "Noticed you're hiring backend engineers (per your careers page).", evidence: ["careers page lists roles"], pass: true },
  { body: "Congrats on your $50M raise!", evidence: [], pass: false },
];
let fail = 0;
for (const c of cases) {
  try { assertNoFabrication(c.body, c.evidence); if (!c.pass) { console.error("FAIL: should have flagged:", c.body); fail++; } }
  catch { if (c.pass) { console.error("FAIL: wrongly flagged:", c.body); fail++; } }
}
console.log(fail === 0 ? "evals passed" : `${fail} eval(s) failed`);
process.exit(fail === 0 ? 0 : 1);
void scoreLead;
