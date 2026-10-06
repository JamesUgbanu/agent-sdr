import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect } from "next/navigation";
import { CampaignForm } from "./CampaignForm";
import { Badge, EmptyState } from "./ui";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  // Workspace-scoped metrics; DB outage degrades to zeros rather than logging out.
  const { workspaceIds } = await requireWorkspaces().catch(() => ({ userId: "", workspaceIds: [] as string[] }));

  let stats = { campaigns: 0, leads: 0, sent: 0, replies: 0, meetings: 0 };
  let warnings: string[] = [];
  let pendingApprovals = 0;
  let failedRuns = 0;
  let workspaces: Array<{ id: string; name: string }> = [];
  try {
    const campIds = (await db.campaign.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true } }).catch(() => [])).map((c) => c.id);
    const [campaigns, leads, sent, replies, meetings, bounced, failed, qualified, optouts, approvals, runs, ws] = await Promise.all([
      db.campaign.count({ where: { workspaceId: { in: workspaceIds } } }),
      db.lead.count({ where: { workspaceId: { in: workspaceIds } } }),
      db.message.count({ where: { status: { in: ["sent", "delivered"] }, thread: { lead: { workspaceId: { in: workspaceIds } } } } }),
      db.message.count({ where: { direction: "inbound", thread: { lead: { workspaceId: { in: workspaceIds } } } } }),
      db.meeting.count({ where: { lead: { workspaceId: { in: workspaceIds } } } }),
      db.message.count({ where: { status: "bounced", thread: { lead: { workspaceId: { in: workspaceIds } } } } }),
      db.message.count({ where: { status: "failed", thread: { lead: { workspaceId: { in: workspaceIds } } } } }),
      db.lead.count({ where: { workspaceId: { in: workspaceIds }, score: { gte: 60 } } }),
      db.suppression.count({ where: { workspaceId: { in: workspaceIds }, reason: "unsubscribed" } }),
      db.approval.count({ where: { status: "pending", lead: { workspaceId: { in: workspaceIds } } } }),
      db.agentRun.count({ where: { status: "failed", campaignId: { in: campIds } } }),
      db.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, name: true } }),
    ]);
    stats = { campaigns, leads, sent, replies, meetings };
    pendingApprovals = approvals;
    failedRuns = runs;
    workspaces = ws;
    if (sent > 0 && bounced / sent >= 0.05) warnings.push(`Bounce rate ${(bounced / sent * 100).toFixed(1)}% ≥ 5% — pause sending and clean the list.`);
    if (failed > 0) warnings.push(`${failed} failed send(s) — check provider credentials and dead letters.`);
    if (optouts > 0 && sent > 0 && optouts / sent >= 0.02) warnings.push(`Opt-out rate ${(optouts / sent * 100).toFixed(1)}% ≥ 2% — review messaging and targeting.`);
    if (leads > 0 && qualified === 0) warnings.push("No qualified leads — review ICP fit or scoring weights.");
  } catch { /* db not migrated yet */ }
  return (
    <div>
      <h1>Campaign Dashboard</h1>
      <p style={{ color: "#9fb0c3" }}>Real backend metrics — drill down into leads, messages, meetings. No vanity metrics.</p>
      {warnings.map((w, i) => (
        <div key={i} role="alert" style={{ background: "#2a1a10", border: "1px solid #b7791f", borderRadius: 8, padding: "8px 12px", marginBottom: 8, fontSize: 13 }}>⚠ {w}</div>
      ))}
      {(pendingApprovals > 0 || failedRuns > 0) && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ color: "#9fb0c3", fontSize: 13 }}>Needs attention:</span>
          {pendingApprovals > 0 && <a href="/approvals" style={{ textDecoration: "none" }}><Badge tone="warn">{pendingApprovals} approval{pendingApprovals === 1 ? "" : "s"} pending</Badge></a>}
          {failedRuns > 0 && <a href="/activity" style={{ textDecoration: "none" }}><Badge tone="bad">{failedRuns} failed run{failedRuns === 1 ? "" : "s"}</Badge></a>}
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {Object.entries(stats).map(([k, v]) => (
          <div key={k} style={{ background: "#131a24", border: "1px solid #1e2530", borderRadius: 10, padding: 16, minWidth: 140 }}>
            <div style={{ color: "#9fb0c3", fontSize: 12 }}>{k.toUpperCase()}</div>
            <div style={{ fontSize: 28, fontWeight: 800 }}>{v}</div>
          </div>
        ))}
      </div>
      <h2 style={{ marginTop: 32 }}>Create campaign</h2>
      {workspaces.length === 0 && stats.campaigns === 0 ? (
        <EmptyState
          title="No workspace yet"
          body="Create a workspace first so campaigns have an isolated home for leads, credentials, and data."
          action={<a href="/onboarding" style={{ color: "#7ea4ff" }}>Start onboarding →</a>}
        />
      ) : (
        <CampaignForm workspaces={workspaces} />
      )}
    </div>
  );
}
