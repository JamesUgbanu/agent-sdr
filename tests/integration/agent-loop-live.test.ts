import { describe, it, expect, beforeAll, vi } from "vitest";
import { db } from "../../src/lib/db";

// Live-DB agent-loop tests: the decision MODEL is scripted, but dispatch,
// validation, execution, persistence, budgets, and guards are all real.
// Skipped gracefully without TEST_DATABASE_URL.

const mockState = vi.hoisted(() => ({
  impl: null as null | ((prompt: string) => unknown),
  prompts: [] as string[],
  leadId: "" as string,
}));
vi.mock("../../src/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "mock",
    generateStructured: async (prompt: string) => {
      mockState.prompts.push(prompt);
      if (!mockState.impl) throw new Error("mock impl not set");
      return mockState.impl(prompt);
    },
    generateText: async () => {
      throw new Error("LLM not configured");
    },
  }),
}));

import { runAgent, resumeRun, DecisionError } from "../../src/server/agents/orchestrator";

let live = false;
beforeAll(async () => {
  mockState.prompts = [];
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
  const ws = await db.workspace.create({ data: { name: `loop-${tag}-${Date.now()}` } });
  const camp = await db.campaign.create({
    data: {
      workspaceId: ws.id, name: `loop-camp-${tag}`, status: "active",
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

async function makeLead(wsId: string, campId: string, title: string, verified: boolean, signals: number) {
  const co = await db.company.create({ data: { workspaceId: wsId, name: `Co-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, domain: `d${Date.now()}${Math.random().toString(36).slice(2, 6)}.example.com` } });
  const ct = await db.contact.create({
    data: { workspaceId: wsId, companyId: co.id, fullName: "Loop Tester", title, email: `loop${Date.now()}@example.com`, emailConfidence: verified ? "verified" : "unknown" },
  });
  const lead = await db.lead.create({ data: { workspaceId: wsId, campaignId: campId, companyId: co.id, contactId: ct.id, status: "NEW" } });
  for (let i = 0; i < signals; i++) {
    await db.leadSignal.create({ data: { leadId: lead.id, type: "new_hiring", strength: 0.8, source: "test" } });
  }
  return lead;
}

describe("agentic loop (live)", () => {
  it("same loop, different observed state/results → different next actions", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("diverge");
    const wsB = await db.workspace.create({ data: { name: `loop-other-${Date.now()}` } });
    // Lead WITH email vs lead WITHOUT email — same run type, same loop code.
    const withEmail = await makeLead(ws.id, camp.id, "CTO", false, 0);
    const noEmailLead = await makeLead(ws.id, camp.id, "CTO", false, 0);
    await db.contact.update({ where: { id: noEmailLead.contactId! }, data: { email: null } });

    // State- and result-dependent policy over the REAL prompt: email present →
    // verify first; no email → skip verification and research directly; after an
    // unavailable verification, adapt by researching instead of stopping.
    mockState.impl = (prompt: string) => {
      const stateJson = prompt.split("STATE_JSON: ")[1]?.split("\n")[0] ?? "{}";
      const email = (JSON.parse(stateJson) as { lead?: { email?: string | null } }).lead?.email;
      const histRaw = prompt.split("HISTORY_JSON (most recent last): ")[1]?.split("\n")[0] ?? "[]";
      const hist = JSON.parse(histRaw) as Array<{ tool: string; ok: boolean; summary: string }>;
      if (!hist.length) {
        return email
          ? { action: "tool", tool: "verifyEmail", args: { leadId: mockState.leadId }, reasoning: "email present, verify first" }
          : { action: "tool", tool: "researchCompany", args: { leadId: mockState.leadId }, reasoning: "no email, research directly" };
      }
      const last = hist[hist.length - 1]!;
      if (last.tool === "verifyEmail") {
        return { action: "tool", tool: "researchCompany", args: { leadId: mockState.leadId }, reasoning: "verification done, research next" };
      }
      return { action: "complete", reason: "enrichment done" };
    };

    mockState.prompts = [];
    mockState.leadId = withEmail.id;
    await runAgent("enrichment", { leadId: withEmail.id }, { leadId: withEmail.id, campaignId: camp.id });
    const toolsA = (await db.agentToolCall.findMany({
      where: { step: { run: { leadId: withEmail.id } } }, orderBy: { createdAt: "asc" },
    })).map((c) => c.tool);
    expect(toolsA).toEqual(["verifyEmail", "researchCompany"]); // adapted after unavailable result
    // The second decision was made with the verification result in context.
    expect(mockState.prompts[1]).toContain("unavailable");

    mockState.prompts = [];
    mockState.leadId = noEmailLead.id;
    await runAgent("enrichment", { leadId: noEmailLead.id }, { leadId: noEmailLead.id, campaignId: camp.id });
    const toolsB = (await db.agentToolCall.findMany({
      where: { step: { run: { leadId: noEmailLead.id } } }, orderBy: { createdAt: "asc" },
    })).map((c) => c.tool);
    expect(toolsB).toEqual(["researchCompany"]); // skipped the inapplicable tool

    // Workspace isolation: the snapshot for ws leads never mentions wsB.
    const { buildSnapshot } = await import("../../src/server/agents/orchestrator");
    const snap = await buildSnapshot("enrichment", { leadId: withEmail.id }, [], 1);
    expect(JSON.stringify(snap)).not.toContain(wsB.id);

    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    await db.workspace.delete({ where: { id: wsB.id } }).catch(() => undefined);
  });

  it("stops after repeated identical successful calls", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("repeat");
    const lead = await makeLead(ws.id, camp.id, "CTO", false, 0);
    mockState.leadId = lead.id;
    mockState.impl = () => ({ action: "tool", tool: "scoreLead", args: { leadId: lead.id }, reasoning: "again" });
    await runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id });
    const rows = await db.leadScore.count({ where: { leadId: lead.id } });
    expect(rows).toBe(2); // third identical call blocked, run escalated
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("needs_review");
    expect(JSON.stringify(run?.output)).toContain("repeated-action");
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("respects maxIterations", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("budget");
    const lead = await makeLead(ws.id, camp.id, "CTO", false, 0);
    mockState.leadId = lead.id;
    mockState.impl = () => ({ action: "tool", tool: "scoreLead", args: { leadId: lead.id } });
    await runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { maxIterations: 1 });
    const calls = await db.agentToolCall.count({ where: { step: { run: { leadId: lead.id } } } });
    expect(calls).toBe(1);
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("needs_review");
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("resumes after failure without re-executing successes", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("resume");
    const lead = await makeLead(ws.id, camp.id, "CTO", false, 0);
    mockState.leadId = lead.id;
    let calls = 0;
    mockState.impl = () => {
      calls++;
      if (calls === 1) return { action: "tool", tool: "scoreLead", args: { leadId: lead.id } };
      throw new Error("worker died");
    };
    let runId = "";
    try {
      await runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id });
    } catch { /* expected */ }
    const failed = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(failed?.status).toBe("failed");
    runId = failed!.id;

    mockState.impl = () => ({ action: "complete", reason: "recovered" });
    await resumeRun(runId);
    const done = await db.agentRun.findUnique({ where: { id: runId } });
    expect(done?.status).toBe("completed");
    const rows = await db.leadScore.count({ where: { leadId: lead.id } });
    expect(rows).toBe(1); // scoreLead NOT re-executed on resume
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("escalates when a safety gate blocks execution", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("gate");
    const lead = await makeLead(ws.id, camp.id, "CTO", false, 0);
    await db.suppression.create({ data: { workspaceId: ws.id, email: (await db.contact.findUnique({ where: { id: lead.contactId! } }))!.email!.toLowerCase(), reason: "unsubscribed" } });
    await db.lead.update({ where: { id: lead.id }, data: { status: "UNSUBSCRIBED" } });
    const thread = await db.messageThread.create({ data: { leadId: lead.id, channel: "email" } });
    const msg = await db.message.create({
      data: { threadId: thread.id, direction: "outbound", subject: "s", body: "b", status: "approved", idempotencyKey: `gate-${Date.now()}` },
    });
    mockState.impl = () => ({ action: "tool", tool: "sendEmail", args: { messageId: msg.id } });
    await runAgent("outreach", { messageId: msg.id }, { leadId: lead.id, campaignId: camp.id });
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("needs_review");
    expect(JSON.stringify(run?.output)).toContain("policy-blocked");
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("rejects model-selected tools outside the permission set", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("perm");
    const lead = await makeLead(ws.id, camp.id, "CTO", false, 0);
    mockState.impl = () => ({ action: "tool", tool: "sendEmail", args: { messageId: "m" } });
    await expect(runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id })).rejects.toThrow(DecisionError);
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("needs_review");
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });
});
