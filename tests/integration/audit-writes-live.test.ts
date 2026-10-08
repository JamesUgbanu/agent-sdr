import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

// Live-DB audit-write tests: persistence failures in the agent path must be
// non-fatal (the run still executes) but observable ([agent] warnings), and
// must never produce false claims of persisted records.
// Skipped gracefully without TEST_DATABASE_URL.
//
// Failures are injected via a db-module mock (targeted async rejections — the
// same shape as real persistence failures). vi.spyOn on Prisma delegates is
// avoided: it does not restore cleanly.

const dbFail = vi.hoisted(() => ({ agentRunUpdate: false, agentStepCreate: false, agentToolCallCreate: false }));
vi.mock("../../src/lib/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib/db")>();
  const delegate = (name: "agentRun" | "agentStep" | "agentToolCall", method: string, flag: keyof typeof dbFail) =>
    new Proxy(mod.db[name], {
      get(t, p, r) {
        if (p === method && dbFail[flag]) return () => Promise.reject(new Error(`injected persist failure (${name}.${method})`));
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  return {
    ...mod,
    db: new Proxy(mod.db, {
      get(t, p, r) {
        if (p === "agentRun") return delegate("agentRun", "update", "agentRunUpdate");
        if (p === "agentStep") return delegate("agentStep", "create", "agentStepCreate");
        if (p === "agentToolCall") return delegate("agentToolCall", "create", "agentToolCallCreate");
        return Reflect.get(t, p, r);
      },
    }),
  };
});

import { db } from "../../src/lib/db";

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
  const ws = await db.workspace.create({ data: { name: `aw-${tag}-${Date.now()}` } });
  const camp = await db.campaign.create({
    data: {
      workspaceId: ws.id, name: `aw-camp-${tag}`, status: "active",
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
    data: { workspaceId: wsId, companyId: co.id, fullName: "Audit Tester", title: "CTO", email: `aw${tag}@example.com`, emailConfidence: "unknown" },
  });
  return db.lead.create({ data: { workspaceId: wsId, campaignId: campId, companyId: co.id, contactId: ct.id, status: "NEW" } });
}

import { runAgent } from "../../src/server/agents/orchestrator";

let warns: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

function captureWarns() {
  warns = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  });
}

afterEach(() => {
  dbFail.agentRunUpdate = false;
  dbFail.agentStepCreate = false;
  dbFail.agentToolCallCreate = false;
  warnSpy?.mockRestore();
  warnSpy = null;
});

const scoreOnceThenDone = (leadId: string) => {
  let n = 0;
  return (async () => {
    if (n++ === 0) return { action: "tool", tool: "scoreLead", args: { leadId }, reasoning: "score" } as const;
    return { action: "complete", reason: "done" } as const;
  }) as never;
};

describe("audit-write failures (live)", () => {
  it("finishRun failure does not crash the loop, warns, and claims nothing", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("finish");
    const lead = await makeLead(ws.id, camp.id);
    captureWarns();
    dbFail.agentRunUpdate = true;
    const out = await runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, {
      decide: (async () => ({ action: "complete", reason: "done" })) as never,
    });
    expect(out).toBeNull(); // loop returned normally
    expect(warns.some((w) => w.includes("[agent] finishRun persist failed"))).toBe(true);
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("running"); // no false terminal claim persisted
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("AgentStep failure still executes the tool, warns, and skips the tool-call row", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("step");
    const lead = await makeLead(ws.id, camp.id);
    captureWarns();
    dbFail.agentStepCreate = true;
    await runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { decide: scoreOnceThenDone(lead.id) });
    expect(await db.leadScore.count({ where: { leadId: lead.id } })).toBe(1); // tool really ran
    expect(warns.some((w) => w.includes("[agent] AgentStep persist failed"))).toBe(true);
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(await db.agentToolCall.count({ where: { step: { runId: run!.id } } })).toBe(0); // no false audit row
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });

  it("AgentToolCall failure still executes the tool and warns", async (ctx) => {
    liveOnly(ctx);
    const { ws, camp } = await makeCampaign("toolcall");
    const lead = await makeLead(ws.id, camp.id);
    captureWarns();
    dbFail.agentToolCallCreate = true;
    await runAgent("qualification", { leadId: lead.id }, { leadId: lead.id, campaignId: camp.id }, { decide: scoreOnceThenDone(lead.id) });
    expect(await db.leadScore.count({ where: { leadId: lead.id } })).toBe(1);
    expect(warns.some((w) => w.includes("[agent] AgentToolCall persist failed"))).toBe(true);
    const run = await db.agentRun.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(await db.agentToolCall.count({ where: { step: { runId: run!.id } } })).toBe(0);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });
});
