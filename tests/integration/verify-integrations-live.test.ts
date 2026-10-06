import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { db } from "../../src/lib/db";
import { verifyWorkspaceIntegrations } from "../../src/lib/verify-integrations";

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

const SAVED_ENV = { ...process.env };
function setEnv(vars: Record<string, string | undefined>) {
  for (const k of ["RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_API_KEY", "HUBSPOT_TOKEN", "APOLLO_API_KEY", "HUNTER_API_KEY", "PDL_API_KEY", "NEVERBOUNCE_API_KEY", "GOOGLE_CALENDAR_TOKEN", "OUTLOOK_TOKEN", "EMAIL_PROVIDER", "PROSPECT_PROVIDER"]) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(SAVED_ENV)) process.env[k] = v;
});

describe("integration verification", () => {
  it("reports not_configured honestly with zero credentials", async (ctx) => {
    liveOnly(ctx);
    setEnv({ EMAIL_PROVIDER: "resend", PROSPECT_PROVIDER: "apollo" });
    const ws = await db.workspace.create({ data: { name: `iv-${Date.now()}` } });
    try {
      const rows = await verifyWorkspaceIntegrations(ws.id);
      expect(rows.some((r) => r.provider === "resend" && r.status === "not_configured")).toBe(true);
      expect(rows.some((r) => r.provider === "apollo" && r.status === "not_configured")).toBe(true);
      expect(rows.some((r) => r.provider === "crm" && r.status === "not_configured")).toBe(true);
      // Nothing resembling a credential may appear in output.
      expect(JSON.stringify(rows)).not.toMatch(/sk-|Bearer|token/i);
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });

  it("distinguishes live auth success from rejection (mocked fetch)", async (ctx) => {
    liveOnly(ctx);
    setEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re-test", PROSPECT_PROVIDER: "hunter", HUNTER_API_KEY: "h-test", NEVERBOUNCE_API_KEY: "nb-test" });
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("resend.com")) return { ok: true, status: 200, json: async () => ({}) };
      if (u.includes("hunter.io")) return { ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" };
      if (u.includes("neverbounce.com")) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}), text: async () => "nope" };
    });
    const ws = await db.workspace.create({ data: { name: `iv-${Date.now()}` } });
    try {
      const rows = await verifyWorkspaceIntegrations(ws.id);
      const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
      expect(byProvider.resend?.status).toBe("pass");
      expect(byProvider.hunter?.status).toBe("fail");
      expect(byProvider.neverbounce?.status).toBe("pass");
      for (const r of rows) expect(r.checkedAt).toBeTruthy();
    } finally {
      await db.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });
});
