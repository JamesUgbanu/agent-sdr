// Guardrails: the agent must never do these; tools enforce them.
import { db } from "./db";

export const TERMINAL_STATUSES = new Set([
  "NOT_INTERESTED", "UNSUBSCRIBED", "BOUNCED", "DISQUALIFIED", "DO_NOT_CONTACT",
]);

// Post-reply states: inbound conversation owns the lead; outbound must stop.
const REPLIED_STATUSES = new Set([
  "REPLIED", "QUALIFIED_REPLY", "MEETING_REQUESTED", "MEETING_BOOKED",
]);

export async function canContactLead(leadId: string): Promise<{ ok: boolean; reason?: string }> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { campaign: true, contact: true },
  }).catch(() => null);
  // Fail CLOSED: if the check itself cannot run, do not authorize outreach.
  if (!lead) return { ok: false, reason: "contact-check-unavailable" };
  if (TERMINAL_STATUSES.has(lead.status)) return { ok: false, reason: `terminal:${lead.status}` };
  if (REPLIED_STATUSES.has(lead.status)) return { ok: false, reason: `replied:${lead.status}` };
  if (lead.campaign.status !== "active") return { ok: false, reason: "campaign-not-active" };
  const email = lead.contact?.email?.toLowerCase();
  if (email) {
    const sup = await db.suppression.findFirst({
      where: { workspaceId: lead.workspaceId, email },
    });
    if (sup) return { ok: false, reason: `suppressed:${sup.reason}` };
  }
  return { ok: true };
}

export function assertNoFabrication(messageBody: string, evidenceClaims: string[]) {
  // Heuristic guard: flag absolute claims about hiring/funding/pricing without evidence anchors.
  const risky = [/we spoke/i, /guarantee/i, /pricing is \$\d+/i, /\$\d+\s*(\/|per\s+month|mo\b)/i, /\$\d+[MBK]?\b.*(rais|fund|round)/i, /rais[a-z]*\s+(a\s+)?\$\d+/i, /you (just )?raised .*funding/i];
  for (const r of risky) {
    if (r.test(messageBody) && evidenceClaims.length === 0) {
      throw new Error(`Guardrail: claim matching ${r} requires evidence`);
    }
  }
}

export function withinWorkingHours(tz: string, start: string, end: string, now = new Date()): boolean {
  // Simplified: compare UTC hour window; full tz support via campaign.timezone at send time.
  void tz;
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  const s = parseTime(start), e = parseTime(end);
  return h >= s && h <= e;
}
function parseTime(t: string) {
  const [h = "0", m = "0"] = t.split(":");
  return Number(h) + Number(m) / 60;
}
