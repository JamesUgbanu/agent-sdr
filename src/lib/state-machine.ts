import { db, J } from "./db";

// Lead state machine — single place where transitions are legal.
const TRANSITIONS: Record<string, string[]> = {
  NEW: ["RESEARCHING", "DISQUALIFIED"],
  RESEARCHING: ["QUALIFIED", "DISQUALIFIED"],
  QUALIFIED: ["READY_FOR_OUTREACH", "DISQUALIFIED"],
  READY_FOR_OUTREACH: ["CONTACTED", "DISQUALIFIED"],
  CONTACTED: ["FOLLOW_UP", "REPLIED", "UNSUBSCRIBED", "BOUNCED"],
  FOLLOW_UP: ["REPLIED", "NOT_INTERESTED", "UNSUBSCRIBED", "MEETING_REQUESTED"],
  REPLIED: ["QUALIFIED_REPLY", "NOT_INTERESTED", "UNSUBSCRIBED", "MEETING_REQUESTED"],
  QUALIFIED_REPLY: ["MEETING_REQUESTED", "NOT_INTERESTED"],
  MEETING_REQUESTED: ["MEETING_BOOKED", "NOT_INTERESTED"],
  MEETING_BOOKED: [],
  NOT_INTERESTED: [],
  UNSUBSCRIBED: [],
  BOUNCED: [],
  DISQUALIFIED: [],
  DO_NOT_CONTACT: [],
};

export function canTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export async function transitionLead(leadId: string, to: string, detail?: unknown) {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error("lead not found");
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
