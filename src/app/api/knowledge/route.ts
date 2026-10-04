import { NextResponse } from "next/server";
import { z } from "zod";
import { withApi } from "@/lib/api";

export const dynamic = "force-dynamic";

const UpsertSchema = z.object({
  workspaceId: z.string(),
  source: z.string().min(1),
  sourceKind: z.string().optional(),
  title: z.string().min(1),
  content: z.string().min(10),
});

// POST: create/update a versioned knowledge document (re-chunks automatically).
async function postHandler(req: Request) {
  const body = UpsertSchema.parse(await req.json());
  const { requireMembership } = await import("@/lib/session");
  await requireMembership(body.workspaceId);
  const { upsertKnowledgeDocument } = await import("@/lib/knowledge");
  const r = await upsertKnowledgeDocument({ ...body });
  return NextResponse.json(r, { status: 201 });
}

// GET ?workspaceId=…&q=… : workspace-isolated retrieval (for testing/grounding).
async function getHandler(req: Request) {
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId");
  const q = searchParams.get("q");
  if (!workspaceId || !q) return NextResponse.json({ error: "workspaceId and q required" }, { status: 400 });
  const { requireMembership } = await import("@/lib/session");
  await requireMembership(workspaceId);
  const { retrieveKnowledge } = await import("@/lib/knowledge");
  return NextResponse.json(await retrieveKnowledge(workspaceId, q));
}

export const POST = withApi(postHandler);
export const GET = withApi(getHandler);
