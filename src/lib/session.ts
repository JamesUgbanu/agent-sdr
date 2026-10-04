import { auth } from "@/auth";
import { db } from "./db";

export async function requireSession(): Promise<{ userId: string; email?: string }> {
  const session = await auth().catch(() => null);
  const userId = (session as unknown as { userId?: string } | null)?.userId;
  if (!userId) throw Object.assign(new Error("unauthenticated — sign in first"), { status: 401 });
  return { userId, email: session?.user?.email ?? undefined };
}

// Session auth + workspace membership. workspaceId is a tenant SELECTOR (from the
// client), authorization comes from the session — never from headers.
export async function requireMembership(workspaceId: string): Promise<{ userId: string; role: string }> {
  const { userId } = await requireSession();
  const m = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!m) throw Object.assign(new Error("forbidden: not a workspace member"), { status: 403 });
  return { userId, role: m.role };
}

export async function requireRole(workspaceId: string, roles: string[]): Promise<{ userId: string }> {
  const m = await requireMembership(workspaceId);
  if (!roles.includes(m.role)) throw Object.assign(new Error("forbidden: insufficient role"), { status: 403 });
  return { userId: m.userId };
}

// For server components: the caller's workspace ids for data scoping.
// Pages must filter every query by these — never render cross-workspace data.
export async function requireWorkspaces(): Promise<{ userId: string; workspaceIds: string[] }> {
  const { userId } = await requireSession();
  const members = await db.workspaceMember.findMany({ where: { userId } });
  return { userId, workspaceIds: members.map((m) => m.workspaceId) };
}
