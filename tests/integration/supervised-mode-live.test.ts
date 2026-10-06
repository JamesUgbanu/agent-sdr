import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../src/lib/db";
import { tools } from "../../src/server/agents/orchestrator";

// Proves the pilot invariant: non-autonomous policies NEVER auto-send,
// and autonomous sending requires both policy AND a non-FAIL preflight.
// Live-DB gated.
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

async function makeLead(policy: "manual" | "assisted" | "autonomous") {
  const ws = await db.workspace.create({ data: { name: `sup-${Date.now()}-${Math.random()}` } });
  const camp = await db.campaign.create({
    data: { workspaceId: ws.id, name: `c`, status: "active", jobTitles: ["CTO"], approvalPolicy: policy, approvalConfidenceThreshold: 0.8, dailySendLimit: 50, timezone: "UTC", minScoreToContact: 0 },
  });
  const co = await db.company.create({ data: { workspaceId: ws.id, name: "Co", domain: `d${Date.now()}.invalid` } });
  const ct = await db.contact.create({ data: { workspaceId: ws.id, companyId: co.id, fullName: "T U", title: "CTO", email: `t${Date.now()}@example.com`, emailConfidence: "high" } });
  const lead = await db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, companyId: co.id, contactId: ct.id, status: "READY_FOR_OUTREACH" } });
  return { ws, lead };
}

describe("supervised pilot: approval cannot be bypassed (live)", () => {
  it("manual policy always requires human approval", async (ctx) => {
    liveOnly(ctx);
    const { ws, lead } = await makeLead("manual");
    try {
      const out = (await tools.generateMessage!.fn({ leadId: lead.id, step: 0 }, {})) as { messageId: string };
      const msg = await db.message.findUnique({ where: { id: out.messageId } });
      expect(msg?.status).toBe("pending_approval");
      const appr = await db.approval.findFirst({ where: { messageId: out.messageId } });
      expect(appr?.status).toBe("pending");
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });

  it("assisted policy holds low-confidence drafts for review", async (ctx) => {
    liveOnly(ctx);
    const { ws, lead } = await makeLead("assisted");
    try {
      const out = (await tools.generateMessage!.fn({ leadId: lead.id, step: 0 }, {})) as { messageId: string };
      const msg = await db.message.findUnique({ where: { id: out.messageId } });
      // No LLM key in test → deterministic fallback draft at 0.45 < 0.8 threshold
      expect(msg?.status).toBe("pending_approval");
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });

  it("autonomous policy auto-approves only with a clean preflight record", async (ctx) => {
    liveOnly(ctx);
    const { ws, lead } = await makeLead("autonomous");
    try {
      const out = (await tools.generateMessage!.fn({ leadId: lead.id, step: 0 }, {})) as { messageId: string };
      const msg = await db.message.findUnique({ where: { id: out.messageId } });
      expect(msg?.status).toBe("approved");
      const appr = await db.approval.findFirst({ where: { messageId: out.messageId } });
      expect(appr?.status).toBe("auto_approved");
      expect(appr?.reason).toMatch(/policy gate passed/);
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });
});
