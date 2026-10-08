import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../src/lib/db";

// Live-DB fallback-observability tests: fallbackDecide() stays fully validated
// and scope-enforced, but its engagement must be auditable (decision.fallback
// event + fallback:true run-output marker). Skipped without TEST_DATABASE_URL.

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
  const ws = await db.workspace.create({ data: { name: `fb-${tag}-${Date.now()}` } });
  const camp = await db.campaign.create({
    data: {
      workspaceId: ws.id, name: `fb-camp-${tag}`, status: "active",
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
    data: { workspaceId: wsId, companyId: co.id, fullName: "Fallback Tester", title: "CTO", email: `fb${tag}@example.com`, emailConfidence: "unknown" },
  });
  return db.lead.create({ data: { workspaceId: wsId, campaignId: campId, companyId: co.id, contactId: ct.id, status: "NEW" } });
}

import { runAgent } from "../../src/server/agents/orchestrator";

const notConfigured = async (): Promise<never> => { throw new Error("OPENAI_API_KEY not configured"); };

describe("fallback observability (live)", () => {
  it("missing LLM configuration emits decision.fallback and marks run output", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("engaged");
    const lead = await makeLead(ws.id, camp.id);
    await runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { decide: notConfigured as never });
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("completed");
    const events = await db.agentEvent.findMany({ where: { kind: "decision.fallback", runId: run!.id } });
    expect(events.length).toBeGreaterThan(0);
    expect((run?.output as { fallback?: boolean })?.fallback).toBe(true);
    // Bounded and validated: exactly one real, validated execution happened.
    expect(await db.leadScore.count({ where: { leadId: lead.id } })).toBe(1);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("fallback decisions still pass scope enforcement", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("scope");
    const own = await makeLead(ws.id, camp.id);
    const otherWs = await db.workspace.create({ data: { name: `fb-other-${Date.now()}` } });
    const otherCamp = await db.campaign.create({
      data: { workspaceId: otherWs.id, name: "other", status: "active", targetIndustries: ["SaaS"], jobTitles: ["CTO"] },
    });
    const other = await makeLead(otherWs.id, otherCamp.id);
    // Fallback only schema-checks its input; the loop must still reject the
    // cross-workspace leadId deterministically.
    await expect(
      runAgent("qualification", { leadId: other.id }, { leadId: own.id, campaignId: camp.id }, { decide: notConfigured as never }),
    ).rejects.toThrow(/outside the run workspace/);
    const run = await db.agentRun.findFirst({ where: { leadId: own.id }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(run?.output)).toContain("invalid-decision");
    expect(await db.leadScore.count({ where: { leadId: other.id } })).toBe(0);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    await db.workspace.delete({ where: { id: otherWs.id } }).catch(() => undefined);
  });

  it("ordinary decide errors do not trigger fallback", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("no-fb");
    const lead = await makeLead(ws.id, camp.id);
    const boom = async (): Promise<never> => { throw new Error("boom"); };
    await expect(
      runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { decide: boom as never }),
    ).rejects.toThrow("boom");
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(run?.output)).toContain("decision-failed");
    expect(await db.agentEvent.count({ where: { kind: "decision.fallback", runId: run!.id } })).toBe(0);
    expect((run?.output as { fallback?: boolean })?.fallback).toBeUndefined();
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });
});
