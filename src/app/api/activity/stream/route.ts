import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Authenticated, workspace-scoped stream: anonymous subscribers see nothing,
  // and members only see events from campaigns in their own workspaces.
  const { requireSession } = await import("@/lib/session");
  const { NextResponse } = await import("next/server");
  let campaignIds: string[];
  try {
    const { userId } = await requireSession();
    const members = await db.workspaceMember.findMany({ where: { userId } });
    const camps = await db.campaign.findMany({
      where: { workspaceId: { in: members.map((m) => m.workspaceId) } },
      select: { id: true },
    });
    campaignIds = camps.map((c) => c.id);
  } catch {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: {"type":"connected"}\n\n`));
      let inFlight = false;
      const timer = setInterval(async () => {
        if (inFlight) return; // skip overlapping ticks when the DB is slow
        inFlight = true;
        try {
          const events = await db.agentEvent.findMany({
            where: { campaignId: { in: campaignIds } },
            orderBy: { createdAt: "desc" }, take: 5,
          });
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(events.map((e: { kind: string; message: string; createdAt: Date }) => ({ kind: e.kind, message: e.message, at: e.createdAt })))}\n\n`));
        } catch { /* db offline */ }
        inFlight = false;
      }, 4000);
      // Close after 5 min
      setTimeout(() => { clearInterval(timer); controller.close(); }, 300_000);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
