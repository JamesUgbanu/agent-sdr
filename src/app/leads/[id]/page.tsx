import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect, notFound } from "next/navigation";
import { Badge, Card, EmptyState } from "../../ui";

export const dynamic = "force-dynamic";

type TimelineItem =
  | { at: Date; kind: "research" | "score" | "message" | "approval" | "reply" | "meeting" | "event"; title: string; detail?: string; tone: "ok" | "warn" | "bad" | "info" };

export default async function LeadDetail({ params }: { params: { id: string } }) {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  const { workspaceIds } = await requireWorkspaces().catch(() => ({ userId: "", workspaceIds: [] as string[] }));
  const lead = await db.lead.findUnique({
    where: { id: params.id },
    include: {
      company: true, contact: true, signals: { orderBy: { detectedAt: "desc" } },
      research: { orderBy: { createdAt: "desc" }, take: 1 },
      scores: { orderBy: { createdAt: "desc" }, take: 1 },
      sequenceState: true,
      threads: { include: { messages: { orderBy: { createdAt: "asc" } } } },
      approvals: { orderBy: { createdAt: "desc" } },
      meetings: { orderBy: { createdAt: "desc" } },
    },
  }).catch(() => null);
  if (!lead || !workspaceIds.includes(lead.workspaceId)) notFound();
  const events = await db.agentEvent.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" }, take: 20 }).catch(() => []);

  const timeline: TimelineItem[] = [];
  for (const r of lead.research) {
    const evidence = (r.evidence as Array<{ claim?: string }> | null) ?? [];
    timeline.push({
      at: r.createdAt, kind: "research", tone: "info",
      title: "Agent researched the company",
      detail: [r.companySummary, `${evidence.length} evidence item${evidence.length === 1 ? "" : "s"} recorded`].filter(Boolean).join(" · "),
    });
  }
  for (const s of lead.scores) {
    timeline.push({
      at: s.createdAt, kind: "score", tone: "info",
      title: `Agent scored this lead ${s.score}/100`,
      detail: s.reasoning ?? undefined,
    });
  }
  for (const t of lead.threads) {
    for (const m of t.messages) {
      const isOut = m.direction === "outbound";
      timeline.push({
        at: m.createdAt,
        kind: m.direction === "inbound" ? "reply" : "message",
        tone: m.status === "failed" || m.status === "bounced" ? "bad" : isOut && m.status === "pending_approval" ? "warn" : "ok",
        title: isOut
          ? `Outreach ${m.sequenceStep != null ? `(step ${m.sequenceStep}) ` : ""}— ${m.status.replace(/_/g, " ")}`
          : `Prospect replied${m.classification ? ` (${m.classification.replace(/_/g, " ")})` : ""}`,
        detail: (m.subject ? `${m.subject} — ` : "") + m.body.slice(0, 220),
      });
    }
  }
  for (const a of lead.approvals) {
    timeline.push({
      at: a.createdAt, kind: "approval", tone: a.status === "pending" ? "warn" : a.status === "approved" || a.status === "auto_approved" ? "ok" : "info",
      title: `Human review: ${a.status.replace(/_/g, " ")}${a.decidedBy ? ` by ${a.decidedBy}` : ""}`,
      detail: a.reason ?? undefined,
    });
  }
  for (const mt of lead.meetings) {
    timeline.push({
      at: mt.createdAt, kind: "meeting", tone: mt.status === "cancelled" ? "bad" : "ok",
      title: `Meeting ${mt.status}: ${mt.title ?? "intro call"}`,
      detail: `${mt.startsAt.toISOString().slice(0, 16).replace("T", " ")} (${mt.timezone})${mt.attendeeEmail ? ` with ${mt.attendeeEmail}` : ""}`,
    });
  }
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime());

  const research = lead.research[0];
  const evidence = (research?.evidence as Array<{ claim: string; source_url: string; confidence: number }> | null) ?? [];

  return (
    <div>
      <h1>{lead.contact?.fullName} @ {lead.company?.name}</h1>
      <p style={{ color: "#9fb0c3" }}>
        {lead.contact?.title} · {lead.contact?.email} · {lead.company?.domain}
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <Badge tone="info">Status: {lead.status.replace(/_/g, " ")}</Badge>
        {lead.score != null && <Badge tone="info">Score: {lead.score}/100</Badge>}
        {lead.sequenceState?.stoppedReason && <Badge tone="warn">Sequence stopped: {lead.sequenceState.stoppedReason}</Badge>}
      </div>

      <h2>Lifecycle timeline</h2>
      {timeline.length === 0 ? (
        <EmptyState title="Nothing happened yet" body="The agent hasn't acted on this lead. Discovery and research appear here first." />
      ) : (
        <ol style={{ paddingLeft: 20 }}>
          {timeline.map((t, i) => (
            <li key={i} style={{ marginBottom: 12 }}>
              <Badge tone={t.tone}>{t.kind}</Badge>{" "}
              <span style={{ color: "#9fb0c3", fontSize: 12 }}>{t.at.toLocaleString()}</span>
              <div style={{ fontWeight: 600, marginTop: 2 }}>{t.title}</div>
              {t.detail && <div style={{ fontSize: 13, color: "#9fb0c3", marginTop: 2 }}>{t.detail}</div>}
            </li>
          ))}
        </ol>
      )}

      <h2>Why this lead? <span style={{ fontSize: 12, color: "#9fb0c3", fontWeight: 400 }}>(agent inference — verify before acting)</span></h2>
      <Card>
        <pre style={{ background: "#0b0e14", padding: 10, borderRadius: 8, overflow: "auto", fontSize: 12, margin: 0 }}>
          {JSON.stringify(lead.scores[0]?.breakdown ?? lead.scoreBreakdown ?? {}, null, 2)}
        </pre>
        {lead.scoreReasoning && <p style={{ fontSize: 13, color: "#9fb0c3" }}>{lead.scoreReasoning}</p>}
      </Card>

      <h2>Verified evidence <span style={{ fontSize: 12, color: "#9fb0c3", fontWeight: 400 }}>(collected from real sources)</span></h2>
      {evidence.length === 0 ? (
        <p style={{ color: "#9fb0c3" }}>No evidence recorded yet — personalization will wait for research.</p>
      ) : (
        <ul>
          {evidence.map((e, i) => (
            <li key={i} style={{ fontSize: 13 }}>
              {e.claim} — <span style={{ color: "#7ea4ff" }}>{e.source_url}</span> (confidence {e.confidence})
            </li>
          ))}
        </ul>
      )}

      {events.length > 0 && (
        <>
          <h2>Recent agent activity</h2>
          <ul style={{ paddingLeft: 18 }}>
            {events.slice(0, 8).map((e) => (
              <li key={e.id} style={{ fontFamily: "monospace", fontSize: 12, color: "#9fb0c3" }}>
                [{e.kind}] {e.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
