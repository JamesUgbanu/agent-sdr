import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { db } from "@/lib/db";
import { withApi } from "@/lib/api";

// POST /api/workspaces { name } — create a workspace owned by the caller.
async function postHandler(req: Request) {
  const { name } = z.object({ name: z.string().min(2).max(100) }).parse(await req.json());
  const { requireSession } = await import("@/lib/session");
  const { userId } = await requireSession();
  const ws = await db.workspace.create({ data: { name } });
  await db.workspaceMember.create({ data: { workspaceId: ws.id, userId, role: "owner" } });
  return NextResponse.json(ws, { status: 201 });
}

async function getHandler(req: Request) {
  const { requireSession } = await import("@/lib/session");
  const { userId } = await requireSession();
  const members = await db.workspaceMember.findMany({ where: { userId }, include: { workspace: true } });
  return NextResponse.json(members.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })));
}

export const POST = withApi(postHandler);
export const GET = withApi(getHandler);
