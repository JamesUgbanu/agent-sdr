import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { withApi } from "@/lib/api";

// GET /api/admin/integrations?workspaceId= — non-destructive credential checks.
// Owner/admin only. Never returns credential values, only pass/fail status.
async function getHandler(req: Request) {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const { requireRole } = await import("@/lib/session");
  await requireRole(workspaceId, ["owner", "admin"]);
  const { verifyWorkspaceIntegrations } = await import("@/lib/verify-integrations");
  return NextResponse.json(await verifyWorkspaceIntegrations(workspaceId));
}

export const GET = withApi(getHandler);
