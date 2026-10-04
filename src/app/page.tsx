import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  // Workspace-scoped metrics; DB outage degrades to zeros rather than logging out.
  const { workspaceIds } = await requireWorkspaces().catch(() => ({ userId: "", workspaceIds: [] as string[] }));

  let stats = { campaigns: 0, leads: 0, sent: 0, replies: 0, meetings: 0 };
  try {
    const [campaigns, leads, sent, replies, meetings] = await Promise.all([
      db.campaign.count({ where: { workspaceId: { in: workspaceIds } } }),
      db.lead.count({ where: { workspaceId: { in: workspaceIds } } }),
      db.message.count({ where: { status: { in: ["sent", "delivered"] }, thread: { lead: { workspaceId: { in: workspaceIds } } } } }),
      db.message.count({ where: { direction: "inbound", thread: { lead: { workspaceId: { in: workspaceIds } } } } }),
      db.meeting.count({ where: { lead: { workspaceId: { in: workspaceIds } } } }),
    ]);
    stats = { campaigns, leads, sent, replies, meetings };
  } catch { /* db not migrated yet */ }
  return (
    <div>
      <h1>Campaign Dashboard</h1>
      <p style={{ color: "#9fb0c3" }}>Real backend metrics — drill down into leads, messages, meetings. No vanity metrics.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {Object.entries(stats).map(([k, v]) => (
          <div key={k} style={{ background: "#131a24", border: "1px solid #1e2530", borderRadius: 10, padding: 16, minWidth: 140 }}>
            <div style={{ color: "#9fb0c3", fontSize: 12 }}>{k.toUpperCase()}</div>
            <div style={{ fontSize: 28, fontWeight: 800 }}>{v}</div>
          </div>
        ))}
      </div>
      <h2 style={{ marginTop: 32 }}>Create campaign</h2>
      <form action="/api/campaigns" method="post" style={{ display: "grid", gap: 8, maxWidth: 480 }}>
        <input name="name" required placeholder="US SaaS CTO Outreach" style={i} />
        <input name="offer" placeholder="Offer, e.g. AI automation implementation" style={i} />
        <input name="jobTitles" placeholder="CTO, VP Engineering (comma-separated)" style={i} />
        <button formAction="/api/campaigns" style={b}>Create (POST /api/campaigns as JSON)</button>
      </form>
      <pre style={{ color: "#9fb0c3", marginTop: 16 }}>{`POST /api/campaigns {"workspaceId":"…","name":"…","jobTitles":["CTO"],"targetIndustries":["SaaS"]}`}</pre>
    </div>
  );
}
const i: React.CSSProperties = { padding: 10, borderRadius: 8, border: "1px solid #2a3444", background: "#0f141c", color: "#fff" };
const b: React.CSSProperties = { padding: 10, borderRadius: 8, background: "#4f7cff", color: "#fff", border: 0, cursor: "pointer" };
