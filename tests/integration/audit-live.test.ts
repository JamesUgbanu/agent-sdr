import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../src/lib/db";
import { canContactLead } from "../../src/lib/policy";
import { resolveModel } from "../../src/lib/models";
import { processRedisMessage } from "../../src/lib/queue";
import { tools } from "../../src/server/agents/orchestrator";
import { workspaceChannel } from "../../src/lib/email";

// Live-DB regression tests for code-quality audit fixes. Skipped without TEST_DATABASE_URL.
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

async function makeWs(tag: string) {
  return db.workspace.create({ data: { name: `audit-${tag}-${Date.now()}` } });
}
async function makeCampaign(wsId: string) {
  const camp = await db.campaign.create({
    data: { workspaceId: wsId, name: `c-${Date.now()}`, status: "active", jobTitles: ["CTO"], approvalPolicy: "assisted", approvalConfidenceThreshold: 0.8, dailySendLimit: 50, timezone: "UTC", minScoreToContact: 60 },
  });
  await db.sequence.create({ data: { campaignId: camp.id, name: "s", steps: { create: [{ order: 0, dayOffset: 0, channel: "email" }] } } });
  return camp;
}
async function makeLead(wsId: string, campId: string, status: string, title = "CTO") {
  const co = await db.company.create({ data: { workspaceId: wsId, name: `Co-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, domain: `nonexistent-${Date.now()}.invalid` } });
  const ct = await db.contact.create({ data: { workspaceId: wsId, companyId: co.id, fullName: "Audit Tester", title, email: `audit${Date.now()}@example.com`, emailConfidence: "high" } });
  return db.lead.create({ data: { workspaceId: wsId, campaignId: campId, companyId: co.id, contactId: ct.id, status } });
}

describe("audit fixes (live)", () => {
  it("resolveModel prefers workspace config over global at equal priority", async (ctx) => {
    liveOnly(ctx);
    const ws = await makeWs("routing");
    await db.modelConfig.create({ data: { task: "reasoning", provider: "openai", model: "global-model", enabled: true, priority: 5 } });
    await db.modelConfig.create({ data: { workspaceId: ws.id, task: "reasoning", provider: "openai", model: "ws-model", enabled: true, priority: 5 } });
    const m = await resolveModel("reasoning", ws.id);
    expect(m.model).toBe("ws-model");
    await db.modelConfig.deleteMany({ where: { task: "reasoning", model: { in: ["global-model", "ws-model"] } } });
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("canContactLead fails closed on missing lead and blocks replied states", async (ctx) => {
    liveOnly(ctx);
    const ws = await makeWs("gate");
    const camp = await makeCampaign(ws.id);
    const replied = await makeLead(ws.id, camp.id, "REPLIED");
    expect((await canContactLead("does-not-exist")).ok).toBe(false);
    const g = await canContactLead(replied.id);
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/replied/);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("researchCompany never regresses post-outreach lead status", async (ctx) => {
    liveOnly(ctx);
    const ws = await makeWs("research");
    const camp = await makeCampaign(ws.id);
    const lead = await makeLead(ws.id, camp.id, "CONTACTED");
    await tools.researchCompany!.fn({ leadId: lead.id }, {});
    const after = await db.lead.findUnique({ where: { id: lead.id } });
    expect(after?.status).toBe("CONTACTED");
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("scoreLead records score without regressing contacted leads", async (ctx) => {
    liveOnly(ctx);
    const ws = await makeWs("score");
    const camp = await makeCampaign(ws.id);
    const lead = await makeLead(ws.id, camp.id, "CONTACTED", "Intern");
    await tools.scoreLead!.fn({ leadId: lead.id }, {});
    const after = await db.lead.findUnique({ where: { id: lead.id } });
    expect(after?.status).toBe("CONTACTED");
    expect(after?.score).not.toBeNull();
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("generateMessage refuses terminal leads", async (ctx) => {
    liveOnly(ctx);
    const ws = await makeWs("draft");
    const camp = await makeCampaign(ws.id);
    const lead = await makeLead(ws.id, camp.id, "UNSUBSCRIBED");
    await expect(tools.generateMessage!.fn({ leadId: lead.id, step: 0 }, {})).rejects.toThrow(/Draft blocked/);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("sendEmail refuses replied leads even with an approved message", async (ctx) => {
    liveOnly(ctx);
    const ws = await makeWs("send");
    const camp = await makeCampaign(ws.id);
    const lead = await makeLead(ws.id, camp.id, "REPLIED");
    const thread = await db.messageThread.create({ data: { leadId: lead.id, channel: "email" } });
    const msg = await db.message.create({
      data: { threadId: thread.id, direction: "outbound", subject: "s", body: "b", status: "approved", idempotencyKey: `audit-${Date.now()}` },
    });
    await expect(tools.sendEmail!.fn({ messageId: msg.id }, {})).rejects.toThrow(/replied:REPLIED/);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("unparseable queue payloads land in dead letters instead of vanishing", async (ctx) => {
    liveOnly(ctx);
    await processRedisMessage("audit-queue", "{not valid json");
    const dl = await db.deadLetter.findFirst({ where: { queue: "audit-queue" }, orderBy: { createdAt: "desc" } });
    expect(dl?.status).toBe("open");
    expect(dl?.lastError).toMatch(/unparseable/);
    if (dl) await db.deadLetter.delete({ where: { id: dl.id } }).catch(() => undefined);
  });

  it("workspaceChannel uses connection credentials without touching process.env", async (ctx) => {
    liveOnly(ctx);
    const ws = await makeWs("emailcfg");
    const before = process.env.RESEND_API_KEY;
    await db.emailConnection.create({
      data: { workspaceId: ws.id, provider: "resend", fromEmail: "sdr@example.com", encryptedConfig: JSON.stringify({ RESEND_API_KEY: "ws-secret-key" }) },
    });
    const resolved = await workspaceChannel(ws.id);
    expect(resolved?.name).toBe("resend");
    expect(process.env.RESEND_API_KEY).toBe(before); // no cross-workspace env leakage
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("searchProspects does not clone contacts on rerun", async (ctx) => {
    liveOnly(ctx);
    const ws = await makeWs("dedupe");
    const camp = await db.campaign.create({
      data: { workspaceId: ws.id, name: `c-${Date.now()}`, status: "active", targetIndustries: ["SaaS"], jobTitles: ["CTO"], approvalPolicy: "assisted", approvalConfidenceThreshold: 0.8, dailySendLimit: 50, timezone: "UTC", minScoreToContact: 60 },
    });
    const r1 = (await tools.searchProspects!.fn({ campaignId: camp.id }, {})) as { leads: number };
    const r2 = (await tools.searchProspects!.fn({ campaignId: camp.id }, {})) as { leads: number };
    const contacts = await db.contact.count({ where: { workspaceId: ws.id } });
    expect(r1.leads).toBeGreaterThan(0);
    expect(r2.leads).toBe(0); // all already known → upserted leads only, no new contacts
    const leadCount = await db.lead.count({ where: { campaignId: camp.id } });
    expect(leadCount).toBe(r1.leads);
    expect(contacts).toBe(r1.leads);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });
});
