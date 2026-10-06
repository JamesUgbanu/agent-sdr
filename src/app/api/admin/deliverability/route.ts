import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { withApi } from "@/lib/api";

// POST /api/admin/deliverability { workspaceId, domain? } — run the
// deliverability preflight and persist the verdict. Owner/admin only.
async function postHandler(req: Request) {
  const { workspaceId, domain } = z.object({
    workspaceId: z.string(), domain: z.string().optional(),
  }).parse(await req.json());
  const { requireRole } = await import("@/lib/session");
  await requireRole(workspaceId, ["owner", "admin"]);
  const { runDeliverabilityPreflight } = await import("@/lib/deliverability");
  const result = await runDeliverabilityPreflight({ workspaceId, domain });
  return NextResponse.json(result, { status: 201 });
}

// GET /api/admin/deliverability?workspaceId= — latest persisted verdict.
async function getHandler(req: Request) {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const { requireRole } = await import("@/lib/session");
  await requireRole(workspaceId, ["owner", "admin"]);
  const { latestPreflightVerdict } = await import("@/lib/deliverability");
  const { db } = await import("@/lib/db");
  const latest = await db.deliverabilityCheck.findFirst({ where: { workspaceId }, orderBy: { createdAt: "desc" } }).catch(() => null);
  return NextResponse.json({ verdict: latest?.verdict ?? null, checkedAt: latest?.createdAt ?? null, checks: (latest?.checks as unknown[]) ?? [] });
}

export const POST = withApi(postHandler);
export const GET = withApi(getHandler);
