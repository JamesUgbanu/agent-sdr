import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { withApi } from "@/lib/api";
import { retryDeadLetter } from "@/lib/queue";
import { db } from "@/lib/db";

async function postHandler(_req: Request, { params }: { params: { id: string } }) {
  // Session first so anonymous callers cannot probe dead-letter existence.
  const { requireSession, requireRole } = await import("@/lib/session");
  await requireSession();
  const dl = await db.deadLetter.findUnique({ where: { id: params.id } });
  if (!dl?.workspaceId) return NextResponse.json({ error: "not found" }, { status: 404 });
  await requireRole(dl.workspaceId, ["owner", "admin"]);
  return NextResponse.json(await retryDeadLetter(params.id));
}

export const POST = withApi(postHandler);
