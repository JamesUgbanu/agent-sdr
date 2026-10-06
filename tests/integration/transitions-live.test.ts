import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../src/lib/db";
import { canTransition, setLeadStatus } from "../../src/lib/state-machine";
import { hashPassword, changePassword, isSessionRevoked } from "../../src/lib/password";

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

describe("state machine table", () => {
  it("covers the real outreach + reply + meeting flows", () => {
    for (const [from, to] of [
      ["READY_FOR_OUTREACH", "CONTACTED"],
      ["CONTACTED", "FOLLOW_UP"],
      ["CONTACTED", "REPLIED"],
      ["CONTACTED", "MEETING_REQUESTED"],
      ["CONTACTED", "NOT_INTERESTED"],
      ["FOLLOW_UP", "REPLIED"],
      ["FOLLOW_UP", "BOUNCED"],
      ["REPLIED", "MEETING_REQUESTED"],
      ["MEETING_REQUESTED", "MEETING_BOOKED"],
      ["NEW", "UNSUBSCRIBED"],
      ["MEETING_BOOKED", "UNSUBSCRIBED"],
      ["NOT_INTERESTED", "UNSUBSCRIBED"],
    ] as Array<[string, string]>) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });
  it("terminal states stay terminal (except unsubscribe, which always wins)", () => {
    expect(canTransition("BOUNCED", "CONTACTED")).toBe(false);
    expect(canTransition("DISQUALIFIED", "READY_FOR_OUTREACH")).toBe(false);
    expect(canTransition("UNSUBSCRIBED", "CONTACTED")).toBe(false);
  });
});

describe("setLeadStatus (live)", () => {
  it("rejects illegal transitions without mutating", async (ctx) => {
    liveOnly(ctx);
    const ws = await db.workspace.create({ data: { name: `sm-${Date.now()}` } });
    const camp = await db.campaign.create({ data: { workspaceId: ws.id, name: `c-${Date.now()}`, status: "active" } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, status: "NEW" } });
    await expect(setLeadStatus(lead.id, "MEETING_BOOKED")).rejects.toThrow(/Illegal transition NEW -> MEETING_BOOKED/);
    expect((await db.lead.findUnique({ where: { id: lead.id } }))?.status).toBe("NEW");
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });
  it("is a no-op when already in state and audits valid moves", async (ctx) => {
    liveOnly(ctx);
    const ws = await db.workspace.create({ data: { name: `sm-${Date.now()}` } });
    const camp = await db.campaign.create({ data: { workspaceId: ws.id, name: `c-${Date.now()}`, status: "active" } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, status: "NEW" } });
    await expect(setLeadStatus(lead.id, "NEW")).resolves.toMatchObject({ unchanged: true });
    await setLeadStatus(lead.id, "RESEARCHING", { test: true });
    expect((await db.lead.findUnique({ where: { id: lead.id } }))?.status).toBe("RESEARCHING");
    const log = await db.activityLog.findFirst({ where: { leadId: lead.id, action: "lead:RESEARCHING" } });
    expect(log).not.toBeNull();
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  });
});

describe("password + revocation (live)", () => {
  it("isSessionRevoked predicate", () => {
    expect(isSessionRevoked(undefined, 0)).toBe(false); // legacy token adopted
    expect(isSessionRevoked(0, 0)).toBe(false);
    expect(isSessionRevoked(0, 1)).toBe(true); // password changed since issue
    expect(isSessionRevoked(2, undefined)).toBe(true); // user gone
    expect(isSessionRevoked(2, null)).toBe(true);
  });
  it("changePassword verifies, rotates, and bumps the version", async (ctx) => {
    liveOnly(ctx);
    const email = `pw-${Date.now()}@example.com`;
    const user = await db.user.create({ data: { email, passwordHash: hashPassword("old-password-1") } });
    try {
      const v0 = (await db.user.findUnique({ where: { id: user.id } }))?.sessionVersion ?? 0;
      await expect(changePassword(user.id, "wrong-password", "new-password-12")).rejects.toThrow(/incorrect/);
      await expect(changePassword(user.id, "old-password-1", "short")).rejects.toThrow(/at least 10/);
      await changePassword(user.id, "old-password-1", "new-password-12");
      const after = await db.user.findUnique({ where: { id: user.id } });
      expect(after?.sessionVersion).toBe(v0 + 1);
      expect(isSessionRevoked(v0, after?.sessionVersion)).toBe(true); // old JWTs now dead
      expect(isSessionRevoked(v0 + 1, after?.sessionVersion)).toBe(false);
    } finally {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
  });
});
