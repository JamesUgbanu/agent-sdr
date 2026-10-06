import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../src/lib/db";
import { evaluateOperationalAlerts } from "../../src/lib/deliverability";

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

describe("operational alerting (live)", () => {
  it("creates a deduplicated ops_alert on bounce spike, stays silent below threshold", async (ctx) => {
    liveOnly(ctx);
    const ws = await db.workspace.create({ data: { name: `ops-${Date.now()}` } });
    const camp = await db.campaign.create({
      data: { workspaceId: ws.id, name: "c", status: "active", jobTitles: ["CTO"], approvalPolicy: "assisted", approvalConfidenceThreshold: 0.8, dailySendLimit: 50, timezone: "UTC", minScoreToContact: 60 },
    });
    const co = await db.company.create({ data: { workspaceId: ws.id, name: "Co", domain: `ops${Date.now()}.invalid` } });
    const ct = await db.contact.create({ data: { workspaceId: ws.id, companyId: co.id, fullName: "O", title: "CTO", email: `ops${Date.now()}@example.com`, emailConfidence: "high" } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, companyId: co.id, contactId: ct.id, status: "CONTACTED" } });
    const thread = await db.messageThread.create({ data: { leadId: lead.id, channel: "email" } });
    try {
      // Below threshold: 2 sent, 0 bounced → no alert.
      for (let i = 0; i < 2; i++) {
        await db.message.create({ data: { threadId: thread.id, direction: "outbound", subject: "s", body: "b", status: "sent", providerMessageId: `ops-fixture-${Date.now()}-${i}`, sentAt: new Date() } });
      }
      expect(await evaluateOperationalAlerts({ workspaceId: ws.id, leadId: lead.id, trigger: "bounce" })).toEqual([]);
      // Push over threshold: 8 more sent + 1 bounced = 10 sent, 10% bounce.
      for (let i = 2; i < 10; i++) {
        await db.message.create({ data: { threadId: thread.id, direction: "outbound", subject: "s", body: "b", status: "sent", providerMessageId: `ops-fixture-${Date.now()}-${i}`, sentAt: new Date() } });
      }
      await db.message.create({ data: { threadId: thread.id, direction: "outbound", subject: "s", body: "b", status: "bounced", providerMessageId: `ops-fixture-${Date.now()}-b`, sentAt: new Date() } });
      const raised = await evaluateOperationalAlerts({ workspaceId: ws.id, leadId: lead.id, trigger: "bounce" });
      expect(raised.some((a) => a.kind === "bounce_spike")).toBe(true);
      const tasks = await db.agentTask.findMany({ where: { leadId: lead.id, type: "ops_alert", status: "open" } });
      expect(tasks.length).toBe(1);
      // Second evaluation dedupes — no duplicate task.
      await evaluateOperationalAlerts({ workspaceId: ws.id, leadId: lead.id, trigger: "bounce" });
      expect(await db.agentTask.count({ where: { leadId: lead.id, type: "ops_alert", status: "open" } })).toBe(1);
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });
});
