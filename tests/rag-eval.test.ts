// RAG evaluation: deterministic retrieval quality over a fixed dataset.
// Uses injected fake embeddings (no API keys needed) so results are stable.
// Measures: hit rate, workspace isolation, unknown handling, evidence presence.
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../src/lib/db";
import { upsertKnowledgeDocument, retrieveKnowledge, __setEmbedOverride } from "../src/lib/knowledge";

let live = false;
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  try {
    await db.$queryRaw`SELECT 1`;
    live = true;
  } catch {
    live = false;
  }
});
function liveOnly(ctx: unknown) {
  if (!live) (ctx as { skip: () => void }).skip();
}

// Deterministic intent vectors: same intent → identical vector (cosine 1.0).
function intentVec(kind: string): number[] {
  const v = new Array<number>(1536).fill(0);
  const idx = { pricing: 7, cancel: 42, objection: 99, competitor: 300, other: 1400 }[kind] ?? 1400;
  v[idx] = 1;
  return v;
}
function kindOf(text: string): string {
  const t = text.toLowerCase();
  if (/cancel|cancellation|30-day|terminate/.test(t)) return "cancel";
  if (/price|cost|\$|pro plan|pricing|much/.test(t)) return "pricing";
  if (/expensive|budget|afford|cheaper/.test(t)) return "objection";
  if (/acme|competitor|compare|versus|alternative/.test(t)) return "competitor";
  return "other";
}

const CASES: Array<{ q: string; expectTitle?: string; kind: "hit" | "unknown" }> = [
  { q: "What does the pro plan cost?", expectTitle: "Plans", kind: "hit" },
  { q: "Can customers cancel within a month?", expectTitle: "Cancellation", kind: "hit" },
  { q: "Your product is too expensive for us.", expectTitle: "Too expensive", kind: "hit" },
  { q: "How do you compare to Acme?", expectTitle: "Vs Acme", kind: "hit" },
  { q: "Do you sell submarines?", kind: "unknown" },
  { q: "What is the capital of Mars?", kind: "unknown" },
];

describe("rag evaluation (live, deterministic vectors)", () => {
  it("retrieves the right evidence, isolates workspaces, handles unknowns", async (ctx) => {
    liveOnly(ctx);
    __setEmbedOverride(async (texts) => texts.map((t) => intentVec(kindOf(t))));
    const wsA = await db.workspace.create({ data: { name: `rag-a-${Date.now()}` } });
    const wsB = await db.workspace.create({ data: { name: `rag-b-${Date.now()}` } });
    try {
      await upsertKnowledgeDocument({ workspaceId: wsA.id, source: "pricing", sourceKind: "pricing", title: "Plans", content: "The Pro plan costs $500 per month with unlimited seats." });
      await upsertKnowledgeDocument({ workspaceId: wsA.id, source: "policy", sourceKind: "policy", title: "Cancellation", content: "Our platform supports annual contracts with a 30-day cancellation period." });
      await upsertKnowledgeDocument({ workspaceId: wsA.id, source: "objections", sourceKind: "objection", title: "Too expensive", content: "When prospects say too expensive, acknowledge budget pressure and restate ROI in hours saved." });
      await upsertKnowledgeDocument({ workspaceId: wsA.id, source: "competitors", sourceKind: "other", title: "Vs Acme", content: "Unlike Acme, we offer onboarding in under a day with no professional services fees." });
      await upsertKnowledgeDocument({ workspaceId: wsB.id, source: "pricing", sourceKind: "pricing", title: "Plans", content: "The Pro plan costs $2000 per month with unlimited seats." });

      let hits = 0;
      for (const c of CASES) {
        const res = await retrieveKnowledge(wsA.id, c.q, { topK: 3 });
        if (c.kind === "unknown") {
          expect(res.length).toBe(0);
          hits++;
          continue;
        }
        const titles = res.map((r) => r.documentTitle);
        expect(titles).toContain(c.expectTitle);
        // Every hit carries evidence references.
        expect(res[0]!.chunkId).toBeTruthy();
        expect(res[0]!.content.length).toBeGreaterThan(0);
        expect(["keyword", "vector", "hybrid"]).toContain(res[0]!.retrieval);
        hits++;
      }
      // Paraphrase specifically required vector retrieval (no keyword overlap).
      const para = await retrieveKnowledge(wsA.id, "Can customers cancel within a month?", { topK: 1 });
      expect(para[0]!.documentTitle).toBe("Cancellation");
      // Cross-workspace isolation with identical query.
      const b = await retrieveKnowledge(wsB.id, "What does the pro plan cost?", { topK: 1 });
      expect(b[0]!.content).toContain("$2000");
      const a = await retrieveKnowledge(wsA.id, "What does the pro plan cost?", { topK: 3 });
      expect(a.every((r) => !r.content.includes("$2000"))).toBe(true);
      console.log(`rag-eval: ${hits}/${CASES.length} cases correct`);
      expect(hits).toBe(CASES.length);
    } finally {
      __setEmbedOverride(null);
      await db.workspace.delete({ where: { id: wsA.id } }).catch(() => undefined);
      await db.workspace.delete({ where: { id: wsB.id } }).catch(() => undefined);
    }
  });
});
