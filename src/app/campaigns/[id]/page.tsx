import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect, notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CampaignDetail({ params }: { params: { id: string } }) {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  const { workspaceIds } = await requireWorkspaces().catch(() => ({ userId: "", workspaceIds: [] as string[] }));
  const c = await db.campaign.findUnique({ where: { id: params.id } }).catch(() => null);
  // Membership check doubles as existence check: other workspaces' campaigns read as not found.
  if (!c || !workspaceIds.includes(c.workspaceId)) notFound();
  const leads = await db.lead.findMany({
    where: { campaignId: params.id }, take: 50, include: { company: true, contact: true },
  }).catch(() => []);
  return (
    <div>
      <h1>{c.name}</h1>
      <p style={{ color: "#9fb0c3" }}>Status: {c.status} · Leads: {leads.length}</p>
      <ul>
        {leads.map((l) => (
          <li key={l.id}><a href={`/leads/${l.id}`} style={{ color: "#7ea4ff" }}>{l.contact?.fullName} @ {l.company?.name}</a> — {l.status} · score {l.score ?? "–"}</li>
        ))}
      </ul>
    </div>
  );
}
