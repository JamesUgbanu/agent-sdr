import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { withApi } from "@/lib/api";
import { listDeadLetters } from "@/lib/queue";

async function getHandler(req: Request) {
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const { requireRole } = await import("@/lib/session");
  await requireRole(workspaceId, ["owner", "admin"]);
  return NextResponse.json(await listDeadLetters("open", 50, workspaceId));
}

export const GET = withApi(getHandler);
