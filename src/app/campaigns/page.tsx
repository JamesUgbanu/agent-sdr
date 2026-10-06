import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect } from "next/navigation";
import { EmptyState } from "../ui";

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
      {campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          body="Create your first campaign to start finding and qualifying prospects. Define who you're targeting, and the agent handles discovery, research, outreach, and follow-ups."
          action={<a href="/onboarding" style={{ color: "#7ea4ff" }}>Set up a campaign in onboarding →</a>}
        />
      ) : (
        <ul>{campaigns.map((c) => <li key={c.id}><a href={`/campaigns/${c.id}`} style={{ color: "#7ea4ff" }}>{c.name}</a> — {c.status}</li>)}</ul>
      )}
    </div>
  );
}
