import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect } from "next/navigation";
import { ApprovalActions } from "./actions";

export const dynamic = "force-dynamic";

export default async function Approvals() {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  const { workspaceIds } = await requireWorkspaces().catch(() => ({ userId: "", workspaceIds: [] as string[] }));
  let items: Array<{
    id: string; reason: string | null; messageId: string | null; createdAt: Date;
    lead: {
      id: string; status: string; score: number | null; scoreBreakdown: unknown; scoreReasoning: string | null;
      contact: { fullName: string | null; title: string | null; email: string | null; linkedinUrl: string | null } | null;
      company: { name: string; domain: string | null } | null;
      campaign: { senderName: string | null; approvalPolicy: string } | null;
      signals: Array<{ type: string; strength: number; source: string | null; expiresAt: Date | null }>;
      research: Array<{ companySummary: string | null; evidence: unknown }>;
      sequenceState: { currentStep: number } | null;
    };
  }> = [];
  try {
    const rows = await db.approval.findMany({
      where: { status: "pending", lead: { workspaceId: { in: workspaceIds } } }, orderBy: { createdAt: "desc" }, take: 50,
      include: {
        lead: {
          include: {
            contact: true, company: true,
            campaign: { select: { senderName: true, approvalPolicy: true } },
            signals: { orderBy: { detectedAt: "desc" }, take: 8 },
            research: { orderBy: { createdAt: "desc" }, take: 1 },
            sequenceState: true,
          },
        },
      },
    });
    items = rows as typeof items;
  } catch { /* db offline */ }

  // message bodies keyed by message id
  let bodies: Record<string, { subject: string | null; body: string; confidence: number | null; sequenceStep: number | null; channel: string; personalizationPoints: string[]; evidenceCount: number }> = {};
  try {
    const mIds = items.map((i) => i.messageId).filter(Boolean) as string[];
    if (mIds.length) {
      const msgs = await db.message.findMany({ where: { id: { in: mIds } }, include: { thread: { select: { channel: true } } } });
      for (const m of msgs) {
        const ev = m.evidenceUsed as { knowledge?: string[] } | Array<unknown> | null;
        bodies[m.id] = {
          subject: m.subject, body: m.body, confidence: m.confidence, sequenceStep: m.sequenceStep,
          channel: m.thread?.channel ?? "email",
          personalizationPoints: m.personalizationPoints,
          evidenceCount: Array.isArray(ev) ? ev.length : (ev?.knowledge?.length ?? 0),
        };
      }
    }
  } catch { /* offline */ }

  return (
    <div>
      <h1>Approval Queue</h1>
      <p style={{ color: "#9fb0c3" }}>{items.length} pending. Every claim below is backed by listed evidence.</p>
      {items.map((a) => <ApprovalCard key={a.id} approval={a} message={a.messageId ? bodies[a.messageId] : undefined} />)}
      {items.length === 0 && <p style={{ color: "#9fb0c3" }}>Queue empty.</p>}
    </div>
  );
}

function ApprovalCard({ approval: a, message: m }: {
  approval: {
    id: string; reason: string | null;
    lead: {
      id: string; status: string; score: number | null; scoreBreakdown: unknown;
      contact: { fullName: string | null; title: string | null; email: string | null; linkedinUrl: string | null } | null;
      company: { name: string; domain: string | null } | null;
      campaign: { senderName: string | null; approvalPolicy: string } | null;
      signals: Array<{ type: string; strength: number; source: string | null; expiresAt: Date | null }>;
      research: Array<{ companySummary: string | null; evidence: unknown }>;
      sequenceState: { currentStep: number } | null;
    };
  };
  message: { subject: string | null; body: string; confidence: number | null; sequenceStep: number | null; channel: string; personalizationPoints: string[]; evidenceCount: number } | undefined;
}) {
  const l = a.lead;
  const research = l.research[0];
  const evidence = (research?.evidence as Array<{ claim: string; source_url: string; confidence: number }> ?? []);
  const points = m?.personalizationPoints ?? [];
  const unsupported = points.filter((p) =>
    !evidence.some((e) => e.claim.toLowerCase().includes(p.toLowerCase().slice(0, 20)) || p.toLowerCase().includes(e.claim.toLowerCase().slice(0, 20)))
  );
  return (
    <div style={{ border: "1px solid #1e2530", borderRadius: 10, padding: 16, marginBottom: 16, background: "#10161f" }}>
      <h3 style={{ margin: "0 0 4px" }}>{l.contact?.fullName ?? "?"} — {l.contact?.title ?? ""} @ {l.company?.name ?? "?"}</h3>
      <div style={{ color: "#9fb0c3", fontSize: 13 }}>
        From: {l.campaign?.senderName ?? "(sender not set)"} → To: {l.contact?.email ?? l.contact?.linkedinUrl ?? "(no address)"} · Channel: {(m?.channel ?? "email").toUpperCase()} · Step {m?.sequenceStep ?? l.sequenceState?.currentStep ?? 0} · Status {l.status}
      </div>
      <div style={{ fontSize: 12, marginTop: 4 }}>
        <a href={`/leads/${l.id}`} style={{ color: "#7ea4ff" }}>View full prospect timeline →</a>
      </div>
      <div style={{ color: "#e8b93e", fontSize: 13, marginTop: 6 }}>Why approval: {a.reason}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
        <section>
          <h4>Score: {l.score ?? "–"}</h4>
          <pre style={pre}>{JSON.stringify(l.scoreBreakdown ?? {}, null, 2)}</pre>
          <h4>Signals ({l.signals.length})</h4>
          <ul>{l.signals.map((s, i) => <li key={i} style={{ fontSize: 13 }}>{s.type} · strength {s.strength} · {s.source} · expires {s.expiresAt?.toISOString().slice(0, 10) ?? "—"}</li>)}</ul>
        </section>
        <section>
          <h4>Research</h4>
          <p style={{ fontSize: 13 }}>{research?.companySummary ?? "none"}</p>
          <h4>Evidence ({evidence.length})</h4>
          <ul>{evidence.map((e, i) => <li key={i} style={{ fontSize: 12 }}>{e.claim} — <span style={{ color: "#7ea4ff" }}>{e.source_url}</span> (conf {e.confidence})</li>)}</ul>
        </section>
      </div>
      <h4>Draft {m?.subject ? `— ${m.subject}` : ""} {m?.confidence != null ? `(conf ${m.confidence})` : ""}</h4>
      <pre style={{ ...pre, whiteSpace: "pre-wrap" }}>{m?.body ?? "(message body unavailable — DB offline)"}</pre>
      <h4>Personalization vs evidence {points.length === 0 ? "(no personalization claims)" : `(${points.length - unsupported.length}/${points.length} supported)`}</h4>
      {points.length === 0 ? (
        <p style={{ fontSize: 13, color: "#9fb0c3" }}>Generic template — safe, but low relevance. Evidence-backed research would improve reply rate.</p>
      ) : (
        <ul>
          {points.map((p, i) => {
            const ok = !unsupported.includes(p);
            return <li key={i} style={{ fontSize: 13 }}>{ok ? "✓" : "⚠ unverified"} {p}{ok ? "" : " — no matching evidence; verify before approving"}</li>;
          })}
        </ul>
      )}
      {m && m.evidenceCount === 0 && (
        <p style={{ fontSize: 13, color: "#e8b93e" }}>No evidence attached to this draft — the agent wrote from the template only.</p>
      )}
      <ApprovalActions id={a.id} />
    </div>
  );
}
const pre: React.CSSProperties = { background: "#0b0e14", padding: 10, borderRadius: 8, overflow: "auto", fontSize: 12 };
