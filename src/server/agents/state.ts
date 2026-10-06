import { db } from "@/lib/db";
import { canContactLead } from "@/lib/policy";
import type { ToolChoice } from "@/lib/llm";

export interface HistoryEntry {
  tool: string;
  ok: boolean;
  summary: string;
}

// Deterministic, persisted agent state. PostgreSQL remains the source of
// truth — this snapshot is rebuilt from the DB on every iteration, never held
// in memory across runs. Redis stays infrastructure (queues/background work),
// never authoritative application state.
export interface StateSnapshot {
  runType: string;
  objective: string;
  iteration: number;
  lead?: { id: string; workspaceId: string; status: string; score: number | null; email: string | null; title: string | null; company: string | null; domain: string | null } | null;
  campaign?: { id: string; status: string; approvalPolicy: string; minScoreToContact: number } | null;
  contactable?: { ok: boolean; reason?: string };
  sequence?: { currentStep: number; nextRunAt: string | null; stoppedReason: string | null } | null;
  pendingApprovals?: number;
  recentMessages?: Array<{ direction: string; status: string; classification: string | null }>;
  history: HistoryEntry[];
}

export type DecideFn = (snap: StateSnapshot, allowed: string[]) => Promise<ToolChoice>;
export interface RunOpts {
  decide?: DecideFn;
  maxIterations?: number;
}

const OBJECTIVES: Record<string, string> = {
  prospecting: "Discover new prospects for the campaign without duplicating or contacting suppressed records.",
  enrichment: "Establish email deliverability and evidence-backed research for the lead.",
  research: "Build evidence-backed company research and signals for the lead.",
  qualification: "Score the lead and determine whether it is worth contacting.",
  personalization: "Produce a personalized, evidence-backed message ready for approval or sending.",
  outreach: "Deliver approved outreach exactly once and synchronize the CRM.",
  reply: "Classify the inbound reply and apply stop, suppress, or routing rules.",
  followup: "Schedule the next appropriate follow-up or stop when the lead state forbids it.",
  crm: "Synchronize the lead state to the configured CRM.",
  meeting: "Establish availability and book or cancel meetings only for real slots.",
  conversation: "Respond helpfully using only authorized knowledge; hand off when knowledge is insufficient.",
};

export function summarizeResult(result: unknown): string {
  try {
    const s = JSON.stringify(result);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(result).slice(0, 500);
  }
}

export async function buildSnapshot(
  runType: string, ids: { campaignId?: string; leadId?: string },
  history: HistoryEntry[], iteration: number,
): Promise<StateSnapshot> {
  const snap: StateSnapshot = {
    runType,
    objective: OBJECTIVES[runType] ?? "Advance the lead according to campaign policy.",
    iteration,
    history: history.slice(-8),
  };
  try {
    if (ids.leadId) {
      const lead = await db.lead.findUnique({
        where: { id: ids.leadId },
        include: { contact: true, company: true, campaign: true, sequenceState: true },
      });
      if (lead) {
        snap.lead = {
          id: lead.id, workspaceId: lead.workspaceId, status: lead.status, score: lead.score,
          email: lead.contact?.email ?? null, title: lead.contact?.title ?? null,
          company: lead.company?.name ?? null, domain: lead.company?.domain ?? null,
        };
        snap.campaign = {
          id: lead.campaign.id, status: lead.campaign.status,
          approvalPolicy: lead.campaign.approvalPolicy, minScoreToContact: lead.campaign.minScoreToContact,
        };
        snap.contactable = await canContactLead(lead.id);
        snap.sequence = lead.sequenceState ? {
          currentStep: lead.sequenceState.currentStep,
          nextRunAt: lead.sequenceState.nextRunAt?.toISOString() ?? null,
          stoppedReason: lead.sequenceState.stoppedReason,
        } : null;
        snap.pendingApprovals = await db.approval.count({ where: { leadId: lead.id, status: "pending" } });
        const msgs = await db.message.findMany({
          where: { thread: { leadId: lead.id } }, orderBy: { createdAt: "desc" }, take: 3,
        });
        snap.recentMessages = msgs.map((m) => ({ direction: m.direction, status: m.status, classification: m.classification }));
      }
    } else if (ids.campaignId) {
      const camp = await db.campaign.findUnique({ where: { id: ids.campaignId } });
      if (camp) {
        snap.campaign = { id: camp.id, status: camp.status, approvalPolicy: camp.approvalPolicy, minScoreToContact: camp.minScoreToContact };
      }
    }
  } catch { /* snapshot degrades gracefully; the loop still decides from history */ }
  return snap;
}
