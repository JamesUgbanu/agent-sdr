import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Campaigns() {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  const { workspaceIds } = await requireWorkspaces().catch(() => ({ userId: "", workspaceIds: [] as string[] }));
  let campaigns: Array<{ id: string; name: string; status: string }> = [];
  try {
    campaigns = await db.campaign.findMany({
      where: { workspaceId: { in: workspaceIds } },
      take: 50, orderBy: { createdAt: "desc" },
    });
  } catch {}
  return (
    <div>
      <h1>Campaigns</h1>
      {campaigns.length === 0 && <p style={{ color: "#9fb0c3" }}>No campaigns yet — POST /api/campaigns.</p>}
      <ul>{campaigns.map((c) => <li key={c.id}><a href={`/campaigns/${c.id}`} style={{ color: "#7ea4ff" }}>{c.name}</a> — {c.status}</li>)}</ul>
    </div>
  );
}
