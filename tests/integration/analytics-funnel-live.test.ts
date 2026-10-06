import { describe, it, expect, beforeAll, vi } from "vitest";
import { db } from "../../src/lib/db";

const sessState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessState.userId) throw Object.assign(new Error("unauthenticated — sign in first"), { status: 401 });
    return { userId: sessState.userId };
  },
  requireMembership: async (workspaceId: string) => {
    if (!sessState.userId) throw Object.assign(new Error("unauthenticated — sign in first"), { status: 401 });
    const { db } = await import("../../src/lib/db");
    const m = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: sessState.userId } } });
    if (!m) throw Object.assign(new Error("forbidden"), { status: 403 });
    return { userId: sessState.userId, role: m.role };
  },
  requireRole: async (workspaceId: string, roles: string[]) => {
    if (!sessState.userId) throw Object.assign(new Error("unauthenticated — sign in first"), { status: 401 });
    const { db } = await import("../../src/lib/db");
    const m = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: sessState.userId } } });
    if (!m || !roles.includes(m.role)) throw Object.assign(new Error("forbidden"), { status: 403 });
    return { userId: sessState.userId };
  },
}));

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

describe("analytics funnel + warnings (live)", () => {
  it("attributes funnel stages per lead source and surfaces warnings", async (ctx) => {
    liveOnly(ctx);
    const user = await db.user.create({ data: { email: `an-${Date.now()}@example.com`, passwordHash: "x" } });
    const ws = await db.workspace.create({ data: { name: `an-${Date.now()}` } });
    await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: "owner" } });
    sessState.userId = user.id;
    try {
      const camp = await db.campaign.create({ data: { workspaceId: ws.id, name: `c-${Date.now()}`, status: "active" } });
      const mk = (source: string | null, status: string, score: number | null) =>
        db.lead.create({ data: { workspaceId: ws.id, campaignId: camp.id, status, source, score } });
      await mk("apollo", "NEW", null);
      await mk("apollo", "MEETING_BOOKED", 90);
      await mk("hunter", "CONTACTED", 70);
      const { GET } = await import("../../src/app/api/analytics/route");
      const res = await GET(new Request(`http://x/api/analytics?campaignId=${camp.id}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        prospectsDiscovered: number; sourceBreakdown: Record<string, { total: number; qualified: number; contacted: number; replied: number; meetings: number }>;
        warnings: string[];
      };
      expect(body.prospectsDiscovered).toBe(3);
      expect(body.sourceBreakdown.apollo).toMatchObject({ total: 2, meetings: 1 });
      expect(body.sourceBreakdown.hunter).toMatchObject({ total: 1, contacted: 1 });
      expect(Array.isArray(body.warnings)).toBe(true);
    } finally {
      sessState.userId = null;
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
  });
});
