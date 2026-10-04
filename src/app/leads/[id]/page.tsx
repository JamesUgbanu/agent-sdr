import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect, notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LeadDetail({ params }: { params: { id: string } }) {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  const { workspaceIds } = await requireWorkspaces().catch(() => ({ userId: "", workspaceIds: [] as string[] }));
  const lead = await db.lead.findUnique({
    where: { id: params.id },
    include: { company: true, contact: true, signals: true, research: true, scores: { orderBy: { createdAt: "desc" }, take: 3 } },
  }).catch(() => null);
  if (!lead || !workspaceIds.includes(lead.workspaceId)) notFound();
  return (
    <div>
      <h1>{lead.contact?.fullName} @ {lead.company?.name}</h1>
      <p>Status: {lead.status} · Score: {lead.score ?? "–"}</p>
      <h3>Why this lead?</h3>
      <pre style={{ background: "#131a24", padding: 12, borderRadius: 8, overflow: "auto" }}>{JSON.stringify({ scoreBreakdown: lead.scoreBreakdown, reasoning: lead.scoreReasoning, signals: lead.signals, research: lead.research }, null, 2)}</pre>
    </div>
  );
}
