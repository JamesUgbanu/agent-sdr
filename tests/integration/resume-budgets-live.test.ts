import { describe, it, expect, beforeAll, vi } from "vitest";
import { db } from "../../src/lib/db";
import { MAX_TOOL_CALLS } from "../../src/lib/budgets";

// Live-DB resume-budget tests: budgets are enforced by continuation of the
// consumed budget across resume — a resume must never grant a fresh window.
// Skipped gracefully without TEST_DATABASE_URL.
//
// The budgets module is mocked with small limits (faithful checkBudgets
// semantics) so the tool-call budget is reachable: with production defaults
// (20 steps / 30 calls) the steps budget always binds first.

const budgetCalls = vi.hoisted(() => ({ newContext: 0 }));
vi.mock("../../src/lib/budgets", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib/budgets")>();
  return {
    ...mod,
    MAX_AGENT_STEPS: 1000,
    MAX_TOOL_CALLS: 5,
    MAX_RUNTIME_MS: 300_000,
    checkBudgets: (ctx: { steps: number; toolCalls: number; startedAt: number }) => {
      if (ctx.steps >= 1000) throw new mod.BudgetError("max-steps exceeded → NEEDS_REVIEW");
      if (ctx.toolCalls >= 5) throw new mod.BudgetError("max-tool-calls exceeded → NEEDS_REVIEW");
      if (Date.now() - ctx.startedAt > 300_000) throw new mod.BudgetError("max-runtime exceeded → NEEDS_REVIEW");
    },
    newContext: (...args: [string?, string?]) => {
      budgetCalls.newContext++;
      return mod.newContext(...args);
    },
  };
});

const llmCap = vi.hoisted(() => ({
  trackings: [] as Array<Record<string, unknown>>,
  impl: null as null | (() => unknown),
}));
vi.mock("../../src/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "mock",
    generateStructured: async (_prompt: string, _schema: unknown, opts: { tracking?: unknown }) => {
      llmCap.trackings.push((opts?.tracking ?? {}) as Record<string, unknown>);
      if (!llmCap.impl) throw new Error("mock impl not set");
      return llmCap.impl();
    },
    generateText: async () => "",
  }),
}));

import { runAgent, resumeRun } from "../../src/server/agents/orchestrator";

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

async function makeCampaign(tag: string) {
  const ws = await db.workspace.create({ data: { name: `rbudget-${tag}-${Date.now()}` } });
  const camp = await db.campaign.create({
    data: {
      workspaceId: ws.id, name: `rbudget-camp-${tag}`, status: "active",
      targetIndustries: ["SaaS"], jobTitles: ["CTO"],
      approvalPolicy: "assisted", approvalConfidenceThreshold: 0.8,
      dailySendLimit: 50, timezone: "UTC", minScoreToContact: 60,
    },
  });
  await db.sequence.create({
    data: { campaignId: camp.id, name: "s", steps: { create: [{ order: 0, dayOffset: 0, channel: "email" }] } },
  });
  return { ws, camp };
}

async function makeLead(wsId: string, campId: string) {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const co = await db.company.create({ data: { workspaceId: wsId, name: `Co-${tag}`, domain: `d${tag}.example.com` } });
  const ct = await db.contact.create({
    data: { workspaceId: wsId, companyId: co.id, fullName: "Budget Tester", title: "CTO", email: `rb${tag}@example.com`, emailConfidence: "unknown" },
  });
  return db.lead.create({ data: { workspaceId: wsId, campaignId: campId, companyId: co.id, contactId: ct.id, status: "NEW" } });
}

async function toolCallCount(runId: string) {
  return db.agentToolCall.count({ where: { step: { runId } } });
}

describe("resume budgets (live)", () => {
  it("fresh run stops exactly at the tool-call budget", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("fresh-calls");
    const lead = await makeLead(ws.id, camp.id);
    // NOTE: the loop increments toolCalls BEFORE the post-increment budget check,
    // so a limit of N permits exactly N-1 executions. That pre-existing fresh-run
    // semantic is pinned here; what matters for Fix 1 is fresh/resume parity.
    let n = 90;
    const decide = async () => ({ action: "tool", tool: "generateMessage", args: { leadId: lead.id, step: n++ }, reasoning: "spend" }) as const;
    try {
      await runAgent("personalization", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { decide, maxIterations: 50 });
    } catch { /* budget-exhausted throws after persisting the terminal state */ }
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(run?.output)).toContain("budget-exhausted");
    expect(await toolCallCount(run!.id)).toBe(MAX_TOOL_CALLS - 1); // exactly 4, never 5
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("resume continues the consumed tool-call budget (no fresh window)", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("resume-calls");
    const lead = await makeLead(ws.id, camp.id);
    let n = 90;
    const seg1 = async () => {
      if (n >= 93) throw new Error("worker died");
      return { action: "tool", tool: "generateMessage", args: { leadId: lead.id, step: n++ }, reasoning: "spend" } as const;
    };
    try {
      await runAgent("personalization", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { decide: seg1, maxIterations: 50 });
    } catch { /* expected */ }
    const failed = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(failed?.status).toBe("failed");
    expect(await toolCallCount(failed!.id)).toBe(3);

    let m = 80;
    const seg2 = async () => ({ action: "tool", tool: "generateMessage", args: { leadId: lead.id, step: m++ }, reasoning: "resume" }) as const;
    try {
      await resumeRun(failed!.id, { decide: seg2, maxIterations: 50 });
    } catch { /* budget-exhausted throws after persisting the terminal state */ }
    const done = await db.agentRun.findUnique({ where: { id: failed!.id } });
    expect(JSON.stringify(done?.output)).toContain("budget-exhausted");
    // 3 consumed + exactly 1 more = 4 (the increment to 5 trips the post-check).
    // A fresh budget on resume (no post-increment check) would allow 3 + 5 = 8.
    expect(await toolCallCount(failed!.id)).toBe(MAX_TOOL_CALLS - 1);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("fresh run stops on the runtime budget", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("fresh-time");
    const lead = await makeLead(ws.id, camp.id);
    const realNow = Date.now();
    let now = realNow;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const decide = async () => {
        now += 400_000; // cross the runtime budget during the first decision
        return { action: "tool", tool: "generateMessage", args: { leadId: lead.id, step: 0 }, reasoning: "spend" } as const;
      };
      try {
        await runAgent("personalization", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { decide, maxIterations: 50 });
      } catch { /* budget-exhausted throws after persisting the terminal state */ }
      const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
      expect(JSON.stringify(run?.output)).toContain("budget-exhausted");
      expect(await toolCallCount(run!.id)).toBe(0); // refused before executing anything
    } finally {
      spy.mockRestore();
    }
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("resumed run honors the original runtime deadline (backdated run)", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("resume-time");
    const lead = await makeLead(ws.id, camp.id);
    let n = 0;
    const seg1 = async () => {
      if (n >= 2) throw new Error("worker died");
      return { action: "tool", tool: "generateMessage", args: { leadId: lead.id, step: n++ }, reasoning: "spend" } as const;
    };
    try {
      await runAgent("personalization", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { decide: seg1, maxIterations: 50 });
    } catch { /* expected */ }
    const failed = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(await toolCallCount(failed!.id)).toBe(2);
    // Simulate a run created 10 minutes ago: elapsed wall-clock continues.
    await db.agentRun.update({ where: { id: failed!.id }, data: { createdAt: new Date(Date.now() - 600_000) } });
    let decideReached = false;
    try {
      await resumeRun(failed!.id, {
        decide: (async () => { decideReached = true; return { action: "complete", reason: "x" }; }) as never,
        maxIterations: 50,
      });
    } catch { /* budget-exhausted throws after persisting the terminal state */ }
    const done = await db.agentRun.findUnique({ where: { id: failed!.id } });
    expect(JSON.stringify(done?.output)).toContain("budget-exhausted");
    expect(await toolCallCount(failed!.id)).toBe(2); // zero new executions
    expect(decideReached).toBe(false); // stopped before deciding
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("one AgentContext per runAgent call; resume reuses the run correlation", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("ctx");
    const lead = await makeLead(ws.id, camp.id);
    const before = budgetCalls.newContext;
    await runAgent("personalization", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, {
      decide: (async () => ({ action: "complete", reason: "done" })) as never,
    });
    expect(budgetCalls.newContext).toBe(before + 1); // exactly one context: row + loop share it
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(run?.correlationId).toBeTruthy();

    // Resume path also builds exactly one context and keeps the correlation.
    const lead2 = await makeLead(ws.id, camp.id);
    const boom = async (): Promise<never> => { throw new Error("worker died"); };
    try {
      await runAgent("personalization", { leadId: lead2.id }, { leadId: lead2.id, campaignId: camp.id }, { decide: boom as never });
    } catch { /* expected */ }
    const failed = await db.agentRun.findFirst({ where: { leadId: lead2.id }, orderBy: { createdAt: "desc" } });
    const beforeResume = budgetCalls.newContext;
    await resumeRun(failed!.id, { decide: (async () => ({ action: "complete", reason: "recovered" })) as never });
    expect(budgetCalls.newContext).toBe(beforeResume + 1);
    const done = await db.agentRun.findUnique({ where: { id: failed!.id } });
    expect(done?.correlationId).toBe(failed?.correlationId);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("resumed decision tracking keeps the workspace (no silent model switch)", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("tracking");
    const lead = await makeLead(ws.id, camp.id);
    let calls = 0;
    llmCap.trackings = [];
    llmCap.impl = () => {
      calls++;
      if (calls === 1) return { action: "tool", tool: "scoreLead", args: { leadId: lead.id }, reasoning: "score" };
      throw new Error("worker died");
    };
    try {
      await runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id });
    } catch { /* expected */ }
    expect(llmCap.trackings.length).toBeGreaterThan(0);
    for (const t of llmCap.trackings) expect(t.workspaceId).toBe(ws.id);

    const failed = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    llmCap.trackings = [];
    llmCap.impl = () => ({ action: "complete", reason: "recovered" });
    await resumeRun(failed!.id);
    expect(llmCap.trackings.length).toBeGreaterThan(0);
    for (const t of llmCap.trackings) expect(t.workspaceId).toBe(ws.id);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });
});
