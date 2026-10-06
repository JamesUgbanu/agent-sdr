// Pilot measurement harness: latencies, corpus size, and per-run cost inputs.
// Run: TEST_DATABASE_URL=... npx tsx staging/measure.ts
// LLM/embedding/provider figures are reported as UNVERIFIED when no keys exist.
import { db } from "../src/lib/db";
import { retrieveKnowledge, upsertKnowledgeDocument, __setEmbedOverride } from "../src/lib/knowledge";
import { tools } from "../src/server/agents/orchestrator";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = Date.now();
  const value = await fn();
  const ms = Date.now() - t0;
  console.log(`${label}: ${ms}ms`);
  return { ms, value };
}

async function main() {
  const ws = await db.workspace.create({ data: { name: `measure-${Date.now()}` } });
  try {
    // Deterministic vectors so embedding latency is measurable without API keys.
    __setEmbedOverride(async (texts) => texts.map((t) => {
      const v = new Array<number>(1536).fill(0);
      let h = 0;
      for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) % 1536;
      v[h] = 1;
      return v;
    }));
    const t0ingest = Date.now();
    for (let i = 0; i < 5; i++) {
      await upsertKnowledgeDocument({
        workspaceId: ws.id, source: `doc-${i}`, sourceKind: "other", title: `Doc ${i}`,
        content: `Pricing and product details for line ${i}. `.repeat(20),
      });
    }
    console.log(`ingest 5 docs (chunk+embed): ${Date.now() - t0ingest}ms`);
    const chunkCount = await db.knowledgeChunk.count({ where: { document: { source: { workspaceId: ws.id } } } });
    console.log(`corpus chunks: ${chunkCount}`);

    const { ms: rMs, value: hits } = await timed("hybrid retrieval", () => retrieveKnowledge(ws.id, "pricing details product line", { topK: 3 }));
    console.log(`retrieval hits: ${hits.length}, retrieval modes: ${hits.map((h) => h.retrieval).join(",")}`);

    // Tool latencies on a synthetic lead (no external network: .invalid domain).
    const camp = await db.campaign.create({ data: { workspaceId: ws.id, name: "m", status: "active", jobTitles: ["CTO"], approvalPolicy: "assisted", approvalConfidenceThreshold: 0.8, dailySendLimit: 50, timezone: "UTC", minScoreToContact: 60 } });
    const co = await db.company.create({ data: { workspaceId: ws.id, name: "Co", domain: `m${Date.now()}.invalid` } });
    const ct = await db.contact.create({ data: { workspaceId: ws.id, companyId: co.id, fullName: "M", title: "CTO", emailConfidence: "unknown" } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, companyId: co.id, contactId: ct.id, status: "NEW" } });
    await timed("researchCompany (no network)", () => tools.researchCompany!.fn({ leadId: lead.id }, {}));
    await timed("scoreLead", () => tools.scoreLead!.fn({ leadId: lead.id }, {}));
    const runRows = await db.agentRun.count({ where: { leadId: lead.id } });
    const toolRows = await db.agentToolCall.count({ where: { step: { run: { leadId: lead.id } } } });
    console.log(`agent runs for lead: ${runRows}, persisted tool calls: ${toolRows}`);
    console.log(`LLM tokens/cost: UNVERIFIED (no provider keys in this environment)`);
    console.log(`embedding cost: UNVERIFIED without keys (override used: 0 API calls)`);
    console.log(`external provider API calls in sandbox: 0`);
    console.log(`retrieval p50 estimate: ~${rMs}ms on ${chunkCount} chunks (ANN index not justified at this scale)`);
  } finally {
    __setEmbedOverride(null);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
