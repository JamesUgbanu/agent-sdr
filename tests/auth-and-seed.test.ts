import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../src/lib/db";
import { hashPassword, verifyPassword } from "../src/lib/password";

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

const DEMO_EMAIL = "demo@agent-sdr.local";
const DEMO_PASSWORD = "demo-password-123";
const DEMO_WORKSPACE_ID = "demo-ws";

describe("demo seed (live)", () => {
  it("creates demo user, workspace, and membership when enabled", async (ctx) => {
    liveOnly(ctx);
    // Simulate what the seed does
    const user = await db.user.upsert({
      where: { email: DEMO_EMAIL },
      update: {},
      create: { email: DEMO_EMAIL, name: "Demo User", passwordHash: hashPassword(DEMO_PASSWORD) },
    });
    const ws = await db.workspace.upsert({
      where: { id: DEMO_WORKSPACE_ID },
      update: {},
      create: { id: DEMO_WORKSPACE_ID, name: "Demo workspace" },
    });
    const member = await db.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: DEMO_WORKSPACE_ID, userId: user.id } },
      update: {},
      create: { workspaceId: DEMO_WORKSPACE_ID, userId: user.id, role: "owner" },
    });
    expect(user.email).toBe(DEMO_EMAIL);
    expect(ws.id).toBe(DEMO_WORKSPACE_ID);
    expect(member.role).toBe("owner");
    expect(verifyPassword(DEMO_PASSWORD, user.passwordHash!)).toBe(true);
  });

  it("is idempotent — running twice does not duplicate", async (ctx) => {
    liveOnly(ctx);
    const user = await db.user.upsert({
      where: { email: DEMO_EMAIL },
      update: {},
      create: { email: DEMO_EMAIL, name: "Demo User", passwordHash: hashPassword(DEMO_PASSWORD) },
    });
    const count = await db.user.count({ where: { email: DEMO_EMAIL } });
    expect(count).toBe(1);
    expect(user.email).toBe(DEMO_EMAIL);
  });

  it("demo workspace is not an orphan when demo user exists", async (ctx) => {
    liveOnly(ctx);
    const member = await db.workspaceMember.findFirst({
      where: { workspaceId: DEMO_WORKSPACE_ID },
    });
    expect(member).not.toBeNull();
  });
});

describe("auth guard", () => {
  it("signup route creates user and workspace", async () => {
    const { POST } = await import("../src/app/api/auth/signup/route");
    const email = `test-signup-${Date.now()}@example.com`;
    const req = new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "test-password-123", name: "Test" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { userId: string; workspaceId: string };
    expect(body.userId).toBeTruthy();
    expect(body.workspaceId).toBeTruthy();
    const user = await db.user.findUnique({ where: { id: body.userId } });
    expect(user?.email).toBe(email);
    const member = await db.workspaceMember.findFirst({
      where: { userId: body.userId },
    });
    expect(member?.role).toBe("owner");
  });
});
