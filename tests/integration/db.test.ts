import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../src/lib/db";

// Live-DB lifecycle tests. Skipped gracefully without TEST_DATABASE_URL + reachable PG.
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

describe("database lifecycle (live)", () => {
  it("workspace isolation: campaigns scoped per workspace", async (ctx) => {
    if (!live) ctx.skip();
    const wsA = await db.workspace.create({ data: { name: `iso-a-${Date.now()}` } });
    const wsB = await db.workspace.create({ data: { name: `iso-b-${Date.now()}` } });
    await db.campaign.create({ data: { workspaceId: wsA.id, name: "A", status: "active" } });
    const inB = await db.campaign.findMany({ where: { workspaceId: wsB.id } });
    expect(inB).toEqual([]);
    await db.workspace.delete({ where: { id: wsA.id } });
    await db.workspace.delete({ where: { id: wsB.id } });
  });

  it("knowledge round-trip stays workspace-scoped", async (ctx) => {
    if (!live) ctx.skip();
    const { upsertKnowledgeDocument, retrieveKnowledge } = await import("../../src/lib/knowledge");
    const ws = await db.workspace.create({ data: { name: `kb-${Date.now()}` } });
    await upsertKnowledgeDocument({
      workspaceId: ws.id, source: "pricing", sourceKind: "pricing",
      title: "Plans", content: "Pro plan costs $99 per month with unlimited seats.",
    });
    const hits = await retrieveKnowledge(ws.id, "how much does pro cost pricing");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("$99");
    const other = await retrieveKnowledge("nonexistent-ws", "pricing pro cost");
    expect(other).toEqual([]);
    await db.workspace.delete({ where: { id: ws.id } });
  });

  it("research cache hits on second read", async (ctx) => {
    if (!live) ctx.skip();
    const { getCachedResearch, putCachedResearch } = await import("../../src/lib/research-cache");
    const ws = await db.workspace.create({ data: { name: `rc-${Date.now()}` } });
    const miss = await getCachedResearch(ws.id, "company", "acme.example.com", "website");
    expect(miss.hit).toBe(false);
    await putCachedResearch(ws.id, "company", "acme.example.com", "website", { summary: "Acme", evidence: [] });
    const hit = await getCachedResearch(ws.id, "company", "acme.example.com", "website");
    expect(hit.hit).toBe(true);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("resolveModel works with deepseek and openrouter model_configs rows", async (ctx) => {
    if (!live) ctx.skip();
    const { resolveModel } = await import("../../src/lib/models");
    const ws = await db.workspace.create({ data: { name: `llm-${Date.now()}` } });
    await db.modelConfig.create({
      data: { workspaceId: ws.id, task: "reasoning", provider: "deepseek", model: "deepseek-chat", enabled: true, priority: 10 },
    });
    await db.modelConfig.create({
      data: { workspaceId: ws.id, task: "classification", provider: "openrouter", model: "anthropic/claude-3.5-sonnet", enabled: true, priority: 10 },
    });
    const deepseek = await resolveModel("reasoning", ws.id);
    expect(deepseek.provider).toBe("deepseek");
    expect(deepseek.model).toBe("deepseek-chat");
    const openrouter = await resolveModel("classification", ws.id);
    expect(openrouter.provider).toBe("openrouter");
    expect(openrouter.model).toBe("anthropic/claude-3.5-sonnet");
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });
});
