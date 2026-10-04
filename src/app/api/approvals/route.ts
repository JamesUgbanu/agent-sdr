import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { db } from "@/lib/db";
import { withApi } from "@/lib/api";

async function getHandler(req: Request) {
  const { requireSession, requireMembership } = await import("@/lib/session");
  const { userId } = await requireSession();
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (workspaceId) await requireMembership(workspaceId);
  const mine = await db.workspaceMember.findMany({ where: { userId } });
  const ids = mine.map((m) => m.workspaceId);
  const pending = await db.approval.findMany({
    where: {
      status: "pending",
      lead: { workspaceId: workspaceId ?? { in: ids } },
    },
    orderBy: { createdAt: "desc" }, take: 50,
    include: { lead: { include: { company: true, contact: true, campaign: true } } },
  });
  return NextResponse.json(pending);
}

export const GET = withApi(getHandler);
