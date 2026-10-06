import { db, J } from "./db";

// Lead state machine — the SINGLE authoritative definition of legal transitions.
// Every lead.status write in tools, workers, and webhooks must go through
// setLeadStatus(). Direct db.lead.update({status}) calls are a bug.
const TRANSITIONS: Record<string, string[]> = {
  NEW: ["RESEARCHING", "READY_FOR_OUTREACH", "DISQUALIFIED", "UNSUBSCRIBED", "NOT_INTERESTED", "MEETING_REQUESTED"],
  RESEARCHING: ["QUALIFIED", "READY_FOR_OUTREACH", "REPLIED", "DISQUALIFIED", "UNSUBSCRIBED", "NOT_INTERESTED", "MEETING_REQUESTED"],
  QUALIFIED: ["READY_FOR_OUTREACH", "REPLIED", "DISQUALIFIED", "UNSUBSCRIBED", "NOT_INTERESTED", "MEETING_REQUESTED"],
  READY_FOR_OUTREACH: ["CONTACTED", "REPLIED", "DISQUALIFIED", "UNSUBSCRIBED", "BOUNCED", "NOT_INTERESTED", "MEETING_REQUESTED"],
  CONTACTED: ["FOLLOW_UP", "REPLIED", "UNSUBSCRIBED", "BOUNCED", "NOT_INTERESTED", "MEETING_REQUESTED"],
  FOLLOW_UP: ["REPLIED", "NOT_INTERESTED", "UNSUBSCRIBED", "MEETING_REQUESTED", "BOUNCED"],
  REPLIED: ["QUALIFIED_REPLY", "NOT_INTERESTED", "UNSUBSCRIBED", "MEETING_REQUESTED"],
  QUALIFIED_REPLY: ["MEETING_REQUESTED", "NOT_INTERESTED", "UNSUBSCRIBED"],
  MEETING_REQUESTED: ["MEETING_BOOKED", "NOT_INTERESTED", "UNSUBSCRIBED"],
  MEETING_BOOKED: ["UNSUBSCRIBED"],
  NOT_INTERESTED: ["UNSUBSCRIBED"],
  UNSUBSCRIBED: [],
  BOUNCED: ["UNSUBSCRIBED"],
  DISQUALIFIED: ["UNSUBSCRIBED"],
  DO_NOT_CONTACT: ["UNSUBSCRIBED"],
};

export function canTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export async function transitionLead(leadId: string, to: string, detail?: unknown) {
  return setLeadStatus(leadId, to, detail);
}

// Authoritative status writer. Idempotent no-op when already in state;
// rejects anything the table does not allow, with an audit trail on success.
export async function setLeadStatus(leadId: string, to: string, detail?: unknown) {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error("lead not found");
  if (lead.status === to) return { unchanged: true as const };
  if (!canTransition(lead.status, to)) {
    throw new Error(`Illegal transition ${lead.status} -> ${to}`);
  }
  return db.$transaction([
    db.lead.update({ where: { id: leadId }, data: { status: to } }),
    db.activityLog.create({
      data: { leadId, campaignId: lead.campaignId, actor: "system", action: `lead:${to}`, detail: J(detail ?? {}) },
    }),
  ]);
}
