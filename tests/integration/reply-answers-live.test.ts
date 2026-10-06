import { describe, it, expect, beforeAll, vi } from "vitest";
import { db } from "../../src/lib/db";

const enqueued: Array<{ name: string; payload: unknown }> = [];
vi.mock("@/lib/queue", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib/queue")>();
  return {
    ...mod,
    enqueue: async (name: string, payload: unknown, opts?: unknown) => {
      enqueued.push({ name, payload });
      return undefined;
    },
  };
});
vi.mock("../../src/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "mock",
    generateStructured: async () => ({ classification: "pricing_question", confidence: 0.9, reason: "asked about cost" }),
    generateText: async () => "",
  }),
}));

import { tools } from "../../src/server/agents/orchestrator";

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

describe("reply handling: high-confidence questions get answers (live)", () => {
  it("pricing_question at high confidence enqueues a conversation draft", async (ctx) => {
    liveOnly(ctx);
    enqueued.length = 0;
    const ws = await db.workspace.create({ data: { name: `q-${Date.now()}` } });
    const camp = await db.campaign.create({
      data: { workspaceId: ws.id, name: "c", status: "active", jobTitles: ["CTO"], approvalPolicy: "assisted", approvalConfidenceThreshold: 0.8, dailySendLimit: 50, timezone: "UTC", minScoreToContact: 60 },
    });
    const co = await db.company.create({ data: { workspaceId: ws.id, name: "Co", domain: `q${Date.now()}.invalid` } });
    const ct = await db.contact.create({ data: { workspaceId: ws.id, companyId: co.id, fullName: "Q", title: "CTO", email: `q${Date.now()}@example.com`, emailConfidence: "high" } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, companyId: co.id, contactId: ct.id, status: "CONTACTED" } });
    const thread = await db.messageThread.create({ data: { leadId: lead.id, channel: "email" } });
    const inbound = await db.message.create({ data: { threadId: thread.id, direction: "inbound", subject: "Re", body: "How much does this cost?" } });
    try {
      const out = (await tools.classifyReply!.fn({ messageId: inbound.id }, {})) as { classification: string };
      expect(out.classification).toBe("pricing_question");
      const convo = enqueued.find((e) => e.name === "conversation");
      expect(convo, "expected a conversation job for a high-confidence pricing question").toBeTruthy();
      expect((convo!.payload as { leadId: string }).leadId).toBe(lead.id);
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });

  it("reply arriving while lead is still READY_FOR_OUTREACH is recorded, not dropped", async (ctx) => {
    liveOnly(ctx);
    enqueued.length = 0;
    const ws = await db.workspace.create({ data: { name: `r-${Date.now()}` } });
    const camp = await db.campaign.create({
      data: { workspaceId: ws.id, name: "c", status: "active", jobTitles: ["CTO"], approvalPolicy: "assisted", approvalConfidenceThreshold: 0.8, dailySendLimit: 50, timezone: "UTC", minScoreToContact: 60 },
    });
    const co = await db.company.create({ data: { workspaceId: ws.id, name: "Co", domain: `r${Date.now()}.invalid` } });
    const ct = await db.contact.create({ data: { workspaceId: ws.id, companyId: co.id, fullName: "R", title: "CTO", email: `r${Date.now()}@example.com`, emailConfidence: "high" } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, companyId: co.id, contactId: ct.id, status: "READY_FOR_OUTREACH" } });
    const thread = await db.messageThread.create({ data: { leadId: lead.id, channel: "email" } });
    const inbound = await db.message.create({ data: { threadId: thread.id, direction: "inbound", subject: "Re", body: "How much does this cost?" } });
    try {
      // Must not throw: a reply is an observed external fact even if it races the send.
      const out = (await tools.classifyReply!.fn({ messageId: inbound.id }, {})) as { classification: string };
      expect(out.classification).toBe("pricing_question");
      expect((await db.lead.findUnique({ where: { id: lead.id } }))?.status).toBe("REPLIED");
      expect(enqueued.some((e) => e.name === "conversation")).toBe(true);
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });
});
