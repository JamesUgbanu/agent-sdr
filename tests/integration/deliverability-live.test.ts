import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { db } from "../../src/lib/db";
import { runDeliverabilityPreflight, latestPreflightVerdict, extractSendingDomain } from "../../src/lib/deliverability";
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

const fakeDns = (records: Record<string, string[][]>) => ({
  lookup: async (host: string) => {
    if (records[`A:${host}`]) return {};
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  },
  resolveTxt: async (host: string) => {
    if (records[`TXT:${host}`]) return records[`TXT:${host}`]!;
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  },
});

describe("deliverability preflight (live, fake DNS)", () => {
  it("extracts sending domains honestly", () => {
    expect(extractSendingDomain("SDR <sdr@example.com>")).toBe("example.com");
    expect(extractSendingDomain("not-an-email")).toBeNull();
  });

  it("FAILs a broken setup and blocks autonomy", async (ctx) => {
    liveOnly(ctx);
    const ws = await db.workspace.create({ data: { name: `dlv-${Date.now()}` } });
    try {
      const dns = fakeDns({});
      const r = await runDeliverabilityPreflight({ workspaceId: ws.id, domain: "nonexistent.invalid", from: "sdr@nonexistent.invalid", dns });
      expect(r.verdict).toBe("FAIL");
      expect(r.autonomousBlocked).toBe(true);
      expect(r.checks.some((c) => c.id === "domain.dns" && c.status === "fail")).toBe(true);
      expect(await latestPreflightVerdict(ws.id)).toBe("FAIL");
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });

  it("PASSes a healthy setup", async (ctx) => {
    liveOnly(ctx);
    const ws = await db.workspace.create({ data: { name: `dlv-${Date.now()}` } });
    await db.campaign.create({ data: { workspaceId: ws.id, name: `c-${Date.now()}`, status: "active", timezone: "UTC" } });
    const prevProvider = process.env.EMAIL_PROVIDER;
    const prevFrom = process.env.EMAIL_FROM;
    const prevSecret = process.env.EMAIL_WEBHOOK_SECRET;
    const prevReply = process.env.EMAIL_REPLY_TO;
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "SDR <sdr@example.com>";
    process.env.EMAIL_REPLY_TO = "reply@example.com";
    process.env.EMAIL_WEBHOOK_SECRET = "test-secret";
    try {
      const dns = fakeDns({
        "A:example.com": [],
        "TXT:example.com": [["v=spf1 include:_spf.example.com ~all"]],
        "TXT:_dmarc.example.com": [["v=DMARC1; p=quarantine"]],
        "TXT:google._domainkey.example.com": [["v=DKIM1; k=rsa; p=abc"]],
      });
      const r = await runDeliverabilityPreflight({ workspaceId: ws.id, domain: "example.com", from: "SDR <sdr@example.com>", dns });
      expect(r.verdict).toBe("PASS");
      expect(r.autonomousBlocked).toBe(false);
      expect(r.checks.find((c) => c.id === "domain.dkim")?.status).toBe("pass");
    } finally {
      if (prevProvider === undefined) delete process.env.EMAIL_PROVIDER; else process.env.EMAIL_PROVIDER = prevProvider;
      if (prevFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = prevFrom;
      if (prevSecret === undefined) delete process.env.EMAIL_WEBHOOK_SECRET; else process.env.EMAIL_WEBHOOK_SECRET = prevSecret;
      if (prevReply === undefined) delete process.env.EMAIL_REPLY_TO; else process.env.EMAIL_REPLY_TO = prevReply;
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });

  it("FAIL verdict downgrades autonomous auto-approval to human review", async (ctx) => {
    liveOnly(ctx);
    const ws = await db.workspace.create({ data: { name: `dlv-${Date.now()}` } });
    try {
      const camp = await db.campaign.create({
        data: { workspaceId: ws.id, name: `c-${Date.now()}`, status: "active", jobTitles: ["CTO"], approvalPolicy: "autonomous", approvalConfidenceThreshold: 0, dailySendLimit: 50, timezone: "UTC", minScoreToContact: 0 },
      });
      const co = await db.company.create({ data: { workspaceId: ws.id, name: "Co", domain: `d${Date.now()}.invalid` } });
      const ct = await db.contact.create({ data: { workspaceId: ws.id, companyId: co.id, fullName: "T", title: "CTO", email: `t${Date.now()}@example.com`, emailConfidence: "high" } });
      const lead = await db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, companyId: co.id, contactId: ct.id, status: "READY_FOR_OUTREACH" } });
      await db.deliverabilityCheck.create({ data: { workspaceId: ws.id, verdict: "FAIL", checks: [] } });
      const out = (await tools.generateMessage!.fn({ leadId: lead.id, step: 0 }, {})) as { messageId: string; status: string };
      const msg = await db.message.findUnique({ where: { id: out.messageId } });
      expect(msg?.status).toBe("pending_approval");
      const appr = await db.approval.findFirst({ where: { messageId: out.messageId } });
      expect(appr?.status).toBe("pending");
      expect(appr?.reason).toMatch(/deliverability/);
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });
});
