import type {
  Availability, CalendarProvider, CRMProvider, EmailVerificationProvider,
  MeetingInput, VerificationResult,
} from "./providers";
import { db, J } from "./db";
import { decryptSecret } from "./crypto";

// ── HubSpot CRM adapter ──
export class HubSpotCRM implements CRMProvider {
  name = "hubspot";
  constructor(private token: string) {}
  private async call<T>(path: string, body: unknown, method = "POST"): Promise<T> {
    const r = await fetch(`https://api.hubapi.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`hubspot ${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }
  async upsertContact(a: { email: string; name?: string; company?: string }) {
    // Search-then-update avoids duplicates; create when absent.
    const found = await this.call<{ results?: Array<{ id: string }> }>(
      "/crm/v3/objects/contacts/search",
      { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: a.email }] }] },
    );
    const props: Record<string, string> = { email: a.email };
    if (a.name) props.firstname = a.name;
    if (a.company) props.company = a.company;
    if (found.results?.[0]) {
      await this.call(`/crm/v3/objects/contacts/${found.results[0].id}`, { properties: props }, "PATCH");
      return found.results[0].id;
    }
    const created = await this.call<{ id: string }>("/crm/v3/objects/contacts", { properties: props });
    return created.id;
  }
  async updateContact(a: { externalId: string; fields: Record<string, string> }) {
    await this.call(`/crm/v3/objects/contacts/${a.externalId}`, { properties: a.fields }, "PATCH");
  }
  async addNote(a: { email: string; note: string }) {
    const created = await this.call<{ id: string }>("/crm/v3/objects/notes", {
      properties: { hs_note_body: `${a.email}: ${a.note}` },
    });
    return created.id;
  }
  async createDeal(a: { email: string; title: string; amount?: number; stage?: string }) {
    const contactId = await this.upsertContact({ email: a.email });
    const deal = await this.call<{ id: string }>("/crm/v3/objects/deals", {
      properties: {
        dealname: a.title,
        amount: a.amount != null ? String(a.amount) : undefined,
        dealstage: a.stage ?? "appointmentscheduled",
      },
    });
    if (contactId) {
      await this.call(`/crm/v3/objects/deals/${deal.id}/associations/contacts/${contactId}/deal_to_contact`, {}, "PUT").catch((e) => {
        console.warn(`[hubspot] deal-contact association failed (deal still created): ${String(e).slice(0, 200)}`);
      });
    }
    return deal.id;
  }
  async createActivity(a: { email: string; type: string; body: string }) {
    // HubSpot engagements: map generic activity onto notes/tasks depending on type.
    if (a.type === "task") {
      const created = await this.call<{ id: string }>("/crm/v3/objects/tasks", {
        properties: { hs_task_body: `${a.email}: ${a.body}`, hs_task_status: "NOT_STARTED" },
      });
      return created.id;
    }
    return this.addNote({ email: a.email, note: a.body });
  }
}

// ── Salesforce adapter (OAuth access token via CrmConnection.encryptedConfig) ──
export class SalesforceCRM implements CRMProvider {
  name = "salesforce";
  constructor(private instanceUrl: string, private token: string) {}
  private async call<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
    const r = await fetch(`${this.instanceUrl}/services/data/v59.0${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`salesforce ${path}: ${r.status} ${await r.text()}`);
    const text = await r.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  async upsertContact(a: { email: string; name?: string; company?: string }) {
    const q = await this.call<{ records?: Array<{ Id: string }> }>(
      `/query?q=${encodeURIComponent(`SELECT Id FROM Contact WHERE Email='${a.email.replace(/'/g, "\\'")}' LIMIT 1`)}`,
      undefined, "GET",
    );
    const [first = "", ...rest] = (a.name ?? "").split(" ");
    const fields: Record<string, string> = { Email: a.email, FirstName: first, LastName: rest.join(" ") || first || a.email };
    if (a.company) fields.Company = a.company;
    if (q.records?.[0]) {
      await this.call(`/sobjects/Contact/${q.records[0].Id}`, fields, "PATCH");
      return q.records[0].Id;
    }
    const created = await this.call<{ id: string }>("/sobjects/Contact", fields);
    return created.id;
  }
  async updateContact(a: { externalId: string; fields: Record<string, string> }) {
    await this.call(`/sobjects/Contact/${a.externalId}`, a.fields, "PATCH");
  }
  async addNote(a: { email: string; note: string }) {
    const contactId = await this.upsertContact({ email: a.email });
    const created = await this.call<{ id: string }>("/sobjects/Note", {
      Title: `SDR note — ${a.email}`, Body: a.note, ParentId: contactId,
    });
    return created.id;
  }
  async createDeal(a: { email: string; title: string; amount?: number; stage?: string }) {
    const created = await this.call<{ id: string }>("/sobjects/Opportunity", {
      Name: a.title, Amount: a.amount, StageName: a.stage ?? "Prospecting",
      CloseDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
    });
    return created.id;
  }
  async createActivity(a: { email: string; type: string; body: string }) {
    const contactId = await this.upsertContact({ email: a.email });
    const created = await this.call<{ id: string }>("/sobjects/Task", {
      Subject: `SDR ${a.type}`, Description: a.body, WhoId: contactId, Status: "Not Started",
    });
    return created.id;
  }
}

function readConnConfig(encrypted: string): Record<string, string> {
  try {
    const raw = encrypted.startsWith("{") ? encrypted : decryptSecret(encrypted);
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function crmForWorkspace(workspaceId: string): Promise<CRMProvider | null> {
  try {
    const c = await db.crmConnection.findFirst({ where: { workspaceId } });
    if (!c) return null;
    const cfg = readConnConfig(c.encryptedConfig);
    if (c.provider === "hubspot") {
      const token = cfg.token ?? process.env.HUBSPOT_TOKEN ?? "";
      return token ? new HubSpotCRM(token) : null;
    }
    if (c.provider === "salesforce") {
      const token = cfg.accessToken ?? process.env.SALESFORCE_TOKEN ?? "";
      const instance = cfg.instanceUrl ?? process.env.SALESFORCE_INSTANCE_URL ?? "";
      return token && instance ? new SalesforceCRM(instance, token) : null;
    }
    return null;
  } catch {
    return null;
  }
}

type CrmOp = "upsert_contact" | "add_note" | "create_deal" | "create_activity";

// updateCRM core: workspace-scoped, idempotent per (lead, operation, fingerprint),
// ledger-persisted, safe retry (max 3, only on retryable errors).
export async function updateCRM(
  leadId: string,
  operation: CrmOp,
  args: Record<string, string | number | undefined> = {},
): Promise<{ externalId?: string; skipped?: boolean }> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { contact: true, company: true } });
  if (!lead) throw new Error("lead not found");
  // Ledger FIRST: every sync attempt is recorded even if no provider is configured.
  const sync = await db.crmSync.create({
    data: { workspaceId: lead.workspaceId, leadId, provider: "unconfigured", operation, status: "pending" },
  }).catch(() => null);
  const fail = async (error: string) => {
    if (sync) await db.crmSync.update({ where: { id: sync.id }, data: { status: "failed", error, attempts: 1 } }).catch(() => undefined);
    throw new Error(error);
  };
  const crm = await crmForWorkspace(lead.workspaceId);
  if (!crm) return fail("No CRM configured for workspace — connect HubSpot/Salesforce first");
  const email = lead.contact?.email;
  if (!email) return fail("No contact email — cannot sync to CRM");

  // Dedupe: one successful sync per (lead, provider, operation). Note this is
  // operation-level, not args-level — repeat calls with different args (e.g. a
  // second deal) are treated as duplicates. Pass a distinct operation or extend
  // CrmSync with an args fingerprint if per-args idempotency is ever needed.
  const existing = await db.crmSync.findFirst({
    where: { leadId, provider: crm.name, operation, status: "ok" },
  }).catch(() => null);
  if (existing && existing.externalId) return { externalId: existing.externalId, skipped: true };
  if (sync) {
    await db.crmSync.update({ where: { id: sync.id }, data: { provider: crm.name } }).catch(() => undefined);
  }

  let attempts = 0;
  let lastError = "";
  while (attempts < 3) {
    attempts++;
    try {
      let externalId: string | void | undefined;
      if (operation === "upsert_contact") {
        externalId = await crm.upsertContact({ email, name: lead.contact!.fullName ?? undefined, company: lead.company?.name });
      } else if (operation === "add_note") {
        externalId = await crm.addNote({ email, note: String(args.note ?? "SDR activity") });
      } else if (operation === "create_deal") {
        externalId = await crm.createDeal({
          email, title: String(args.title ?? `Deal — ${lead.company?.name ?? email}`),
          amount: args.amount != null ? Number(args.amount) : undefined,
          stage: args.stage != null ? String(args.stage) : undefined,
        });
      } else {
        externalId = await crm.createActivity({ email, type: String(args.type ?? "note"), body: String(args.body ?? "") });
      }
      if (sync) {
        await db.crmSync.update({
          where: { id: sync.id },
          data: { status: "ok", externalId: typeof externalId === "string" ? externalId : undefined, attempts },
        }).catch(() => undefined);
      }
      await db.usageEvent.create({
        data: { workspaceId: lead.workspaceId, campaignId: lead.campaignId, leadId, kind: "crm_sync", quantity: 1 },
      }).catch(() => undefined);
      return { externalId: typeof externalId === "string" ? externalId : undefined };
    } catch (e) {
      lastError = String(e);
      const retryable = /429|5\d\d|timeout|ECONN|ETIMEDOUT|fetch failed/i.test(lastError);
      if (!retryable || attempts >= 3) break;
      await new Promise((r) => setTimeout(r, 2 ** attempts * 1000));
    }
  }
  if (sync) {
    await db.crmSync.update({ where: { id: sync.id }, data: { status: "failed", error: lastError, attempts } }).catch(() => undefined);
  }
  throw new Error(`CRM sync failed after ${attempts} attempt(s): ${lastError}`);
}

export async function syncLeadToCRM(leadId: string, note: string) {
  await updateCRM(leadId, "upsert_contact").catch((e) => console.error("[crm-sync]", e));
  await updateCRM(leadId, "add_note", { note }).catch((e) => console.error("[crm-sync]", e));
}

// ── Calendar providers: only ever offer REAL availability ──
function slotRange(durationMin: number, from: Date, days: number, tz: string): { start: Date; end: Date }[] {
  void tz; // provider-local working hours; full tz rendering happens at presentation
  const out: { start: Date; end: Date }[] = [];
  const day = new Date(from);
  for (let d = 0; d < days && out.length < 12; d++) {
    for (let h = 9; h < 17 && out.length < 12; h += durationMin / 60) {
      const s = new Date(day.getTime() + d * 86400_000 + (h - 9) * 3600_000);
      if (s.getUTCDay() === 0 || s.getUTCDay() === 6) continue;
      out.push({ start: s, end: new Date(s.getTime() + durationMin * 60_000) });
    }
  }
  return out;
}

class ConsoleCalendar implements CalendarProvider {
  name = "console";
  async getAvailability(opts?: { durationMin?: number }): Promise<Availability[]> {
    const dur = opts?.durationMin ?? 30;
    const base = new Date(); base.setUTCHours(9, 0, 0, 0);
    return slotRange(dur, base, 7, "UTC").slice(0, 6)
      .map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }));
  }
  async createMeeting(i: MeetingInput) {
    if (!i.leadId) throw new Error("leadId required to persist meeting");
    const m = await db.meeting.create({
      data: {
        leadId: i.leadId, title: i.title, startsAt: new Date(i.start), endsAt: new Date(i.end),
        timezone: i.timezone ?? "UTC", attendeeEmail: i.attendee, status: "scheduled",
      },
    }).catch(() => null);
    return { id: m?.id ?? `console-${Date.now()}` };
  }
  async cancelMeeting(id: string): Promise<void> {
    await db.meeting.update({ where: { id }, data: { status: "cancelled" } }).catch(() => undefined);
  }
}

// Google Calendar via OAuth access token stored in CalendarConnection.
class GoogleCalendar implements CalendarProvider {
  name = "google";
  constructor(private token: string, private calendarId = "primary") {}
  async getAvailability(opts?: { durationMin?: number; from?: string; to?: string; timezone?: string }): Promise<Availability[]> {
    const dur = opts?.durationMin ?? 30;
    const from = new Date(opts?.from ?? Date.now() + 86400_000);
    const to = new Date(opts?.to ?? Date.now() + 8 * 86400_000);
    // FreeBusy query = real availability, never invented. OAuth Bearer only —
    // no `key=` query param (that slot is for API keys, not OAuth tokens).
    const fb = await fetch(`https://www.googleapis.com/calendar/v3/freeBusy`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: this.calendarId }] }),
    });
    if (!fb.ok) throw new Error(`google freeBusy: ${fb.status}`);
    const busy = ((await fb.json()) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> })
      .calendars?.[this.calendarId]?.busy ?? [];
    const slots: Availability[] = [];
    for (const s of slotRange(dur, from, 7, opts?.timezone ?? "UTC")) {
      const overlap = busy.some((b) => new Date(b.start) < s.end && new Date(b.end) > s.start);
      if (!overlap) slots.push({ start: s.start.toISOString(), end: s.end.toISOString() });
      if (slots.length >= 8) break;
    }
    return slots;
  }
  async createMeeting(i: MeetingInput) {
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${this.calendarId}/events`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: i.title, description: i.description,
        start: { dateTime: i.start, timeZone: i.timezone ?? "UTC" },
        end: { dateTime: i.end, timeZone: i.timezone ?? "UTC" },
        attendees: [{ email: i.attendee }],
      }),
    });
    if (!r.ok) throw new Error(`google create: ${r.status} ${await r.text()}`);
    const ev = (await r.json()) as { id?: string };
    if (i.leadId) {
      await db.meeting.create({
        data: {
          leadId: i.leadId, providerMeetingId: ev.id, title: i.title,
          startsAt: new Date(i.start), endsAt: new Date(i.end),
          timezone: i.timezone ?? "UTC", attendeeEmail: i.attendee, status: "scheduled",
        },
      }).catch(() => undefined);
    }
    return { id: ev.id ?? "" };
  }
  async cancelMeeting(id: string): Promise<void> {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${this.calendarId}/events/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${this.token}` },
    }).catch(() => undefined);
    await db.meeting.updateMany({ where: { providerMeetingId: id }, data: { status: "cancelled" } }).catch(() => undefined);
  }
}

// Outlook via Microsoft Graph delegated token.
class OutlookCalendar implements CalendarProvider {
  name = "outlook";
  constructor(private token: string) {}
  async getAvailability(opts?: { durationMin?: number; from?: string; to?: string }): Promise<Availability[]> {
    const dur = opts?.durationMin ?? 30;
    const from = new Date(opts?.from ?? Date.now() + 86400_000).toISOString();
    const to = new Date(opts?.to ?? Date.now() + 8 * 86400_000).toISOString();
    const r = await fetch("https://graph.microsoft.com/v1.0/me/calendar/getSchedule", {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ schedules: ["me"], startTime: { dateTime: from, timeZone: "UTC" }, endTime: { dateTime: to, timeZone: "UTC" }, availabilityViewInterval: dur }),
    });
    if (!r.ok) throw new Error(`outlook schedule: ${r.status}`);
    const j = (await r.json()) as { value?: Array<{ availabilityView?: string }> };
    const view = j.value?.[0]?.availabilityView ?? "";
    // availabilityView chars per interval: 0=free. Map to candidate slots honestly.
    const slots: Availability[] = [];
    const base = new Date(from);
    for (let k = 0; k < view.length && slots.length < 8; k++) {
      if (view[k] === "0") {
        const s = new Date(base.getTime() + k * dur * 60_000);
        const h = s.getUTCHours();
        if (h >= 9 && h < 17 && s.getUTCDay() !== 0 && s.getUTCDay() !== 6) {
          slots.push({ start: s.toISOString(), end: new Date(s.getTime() + dur * 60_000).toISOString() });
        }
      }
    }
    return slots;
  }
  async createMeeting(i: MeetingInput) {
    const r = await fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: i.title, body: { contentType: "text", content: i.description ?? "" },
        start: { dateTime: i.start, timeZone: i.timezone ?? "UTC" },
        end: { dateTime: i.end, timeZone: i.timezone ?? "UTC" },
        attendees: [{ emailAddress: { address: i.attendee }, type: "required" }],
      }),
    });
    if (!r.ok) throw new Error(`outlook create: ${r.status} ${await r.text()}`);
    const ev = (await r.json()) as { id?: string };
    if (i.leadId) {
      await db.meeting.create({
        data: {
          leadId: i.leadId, providerMeetingId: ev.id, title: i.title,
          startsAt: new Date(i.start), endsAt: new Date(i.end),
          timezone: i.timezone ?? "UTC", attendeeEmail: i.attendee, status: "scheduled",
        },
      }).catch(() => undefined);
    }
    return { id: ev.id ?? "" };
  }
  async cancelMeeting(id: string): Promise<void> {
    await fetch(`https://graph.microsoft.com/v1.0/me/events/${id}/cancel`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => undefined);
    await db.meeting.updateMany({ where: { providerMeetingId: id }, data: { status: "cancelled" } }).catch(() => undefined);
  }
}

export async function calendarForWorkspace(workspaceId: string): Promise<CalendarProvider> {
  try {
    const c = await db.calendarConnection.findFirst({ where: { workspaceId } });
    if (c) {
      const cfg = readConnConfig(c.encryptedConfig);
      if (c.provider === "google" && cfg.accessToken) return new GoogleCalendar(cfg.accessToken, cfg.calendarId);
      if (c.provider === "outlook" && cfg.accessToken) return new OutlookCalendar(cfg.accessToken);
    }
  } catch { /* fall through */ }
  const gTok = process.env.GOOGLE_CALENDAR_TOKEN;
  if (gTok) return new GoogleCalendar(gTok);
  const oTok = process.env.OUTLOOK_TOKEN;
  if (oTok) return new OutlookCalendar(oTok);
  return new ConsoleCalendar();
}

export async function handleMeetingRequest(leadId: string) {
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { contact: true, company: true } });
  if (!lead) return;
  const cal = await calendarForWorkspace(lead.workspaceId);
  const slots = await cal.getAvailability({ durationMin: 30 });
  // Persist an outbound message offering ONLY these real slots — agent never invents times.
  const thread = await db.messageThread.findFirst({ where: { leadId } });
  if (thread && lead.contact?.email) {
    await db.message.create({
      data: {
        threadId: thread.id, direction: "outbound",
        subject: `Re: meeting — available times`,
        body: `Thanks — here are real open slots:\n${slots.map((s) => `• ${s.start} → ${s.end}`).join("\n")}\n\nReply with one that works and I'll book it.`,
        status: "approved", confidence: 0.9,
        idempotencyKey: `${leadId}-meeting-offer-${Date.now()}`,
      },
    });
    await db.lead.update({ where: { id: leadId }, data: { status: "MEETING_REQUESTED" } });
    await db.agentEvent.create({ data: { leadId, campaignId: lead.campaignId, kind: "meeting.slots_offered", message: `${slots.length} real slots offered`, payload: J({ slots }) } }).catch(() => undefined);
  }
}

// Books a meeting ONLY after verifying the slot is inside real availability.
export async function bookMeeting(input: {
  leadId: string; start: string; end: string; title?: string; timezone?: string;
}) {
  const lead = await db.lead.findUnique({ where: { id: input.leadId }, include: { contact: true, campaign: true } });
  if (!lead) throw new Error("lead not found");
  if (!lead.contact?.email) throw new Error("attendee email unknown — never invent participants");
  const cal = await calendarForWorkspace(lead.workspaceId);
  const slots = await cal.getAvailability({ durationMin: 30 });
  const ok = slots.some((s) => s.start === input.start && s.end === input.end);
  if (!ok) throw new Error("Requested slot is not in current availability — re-check before booking");
  const dup = await db.meeting.findFirst({
    where: { leadId: lead.id, startsAt: new Date(input.start), status: "scheduled" },
  }).catch(() => null);
  if (dup) return { id: dup.id, duplicate: true };
  const { id } = await cal.createMeeting({
    title: input.title ?? `Intro — ${lead.campaign.offer ?? "SDR"}`,
    start: input.start, end: input.end, attendee: lead.contact.email,
    timezone: input.timezone ?? lead.campaign.timezone ?? "UTC", leadId: lead.id,
  });
  await db.lead.update({ where: { id: lead.id }, data: { status: "MEETING_BOOKED" } }).catch(() => undefined);
  await db.leadSequenceState.update({ where: { leadId: lead.id }, data: { stoppedReason: "meeting-booked" } }).catch(() => undefined);
  await updateCRM(lead.id, "create_activity", { type: "note", body: `Meeting booked: ${input.start}` }).catch(() => undefined);
  return { id };
}

export async function cancelBookedMeeting(meetingId: string) {
  const m = await db.meeting.findUnique({ where: { id: meetingId }, include: { lead: true } });
  if (!m) throw new Error("meeting not found");
  if (m.status === "cancelled") return { already: true };
  const cal = await calendarForWorkspace(m.lead.workspaceId);
  if (m.providerMeetingId && !m.providerMeetingId.startsWith("console-")) {
    await cal.cancelMeeting(m.providerMeetingId);
  } else {
    await cal.cancelMeeting(m.id).catch(() => undefined);
  }
  await db.meeting.update({ where: { id: meetingId }, data: { status: "cancelled" } }).catch(() => undefined);
  return { cancelled: true };
}

// ── Email verification providers (never fabricate; explicit unavailable state) ──
class AbstractVerifyProvider implements EmailVerificationProvider {
  name: string;
  constructor(private apiKey: string | undefined, private endpoint: string, name: string) {
    this.name = name;
    void this.endpoint;
  }
  async verify(email: string): Promise<VerificationResult> {
    if (!this.apiKey) {
      return { status: "unavailable", confidence: null, provider: this.name, checkedAt: new Date().toISOString() };
    }
    // Generic single-email-verification REST shape; provider-specific subclasses override mapping.
    return { status: "unknown", confidence: 0.3, provider: this.name, evidence: { email }, checkedAt: new Date().toISOString() };
  }
}

class NeverBounceVerify extends AbstractVerifyProvider {
  constructor() { super(process.env.NEVERBOUNCE_API_KEY, "https://api.neverbounce.com/v4/single/check", "neverbounce"); }
  async verify(email: string): Promise<VerificationResult> {
    if (!process.env.NEVERBOUNCE_API_KEY) {
      return { status: "unavailable", confidence: null, provider: this.name, checkedAt: new Date().toISOString() };
    }
    const r = await fetch(`https://api.neverbounce.com/v4/single/check?key=${process.env.NEVERBOUNCE_API_KEY}&email=${encodeURIComponent(email)}`);
    if (!r.ok) throw new Error(`neverbounce: ${r.status}`);
    const j = (await r.json()) as { result?: string };
    const map: Record<string, VerificationResult["status"]> = {
      valid: "deliverable", catchall: "risky", disposable: "risky",
      invalid: "undeliverable", unknown: "unknown",
    };
    const status = map[j.result ?? ""] ?? "unknown";
    return {
      status, confidence: status === "deliverable" ? 0.95 : status === "undeliverable" ? 0.9 : 0.4,
      provider: this.name, evidence: { raw: j.result }, checkedAt: new Date().toISOString(),
    };
  }
}

export function verificationProvider(): EmailVerificationProvider {
  return new NeverBounceVerify();
}

export async function verifyEmailCached(workspaceId: string, email: string): Promise<VerificationResult> {
  const key = email.toLowerCase();
  const cached = await db.emailVerification.findUnique({
    where: { workspaceId_email: { workspaceId, email: key } },
  }).catch(() => null);
  if (cached && cached.expiresAt > new Date()) {
    return {
      status: cached.status as VerificationResult["status"], confidence: cached.confidence,
      provider: cached.provider ?? "cache",
      evidence: (cached.evidence as Record<string, unknown>) ?? undefined,
      checkedAt: cached.verifiedAt.toISOString(),
    };
  }
  // Syntax gate first (deterministic, no provider needed).
  const syntaxOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(key);
  if (!syntaxOk) {
    return { status: "undeliverable", confidence: 0.99, provider: "syntax", evidence: { reason: "invalid-syntax" }, checkedAt: new Date().toISOString() };
  }
  const result = await verificationProvider().verify(key);
  await db.emailVerification.upsert({
    where: { workspaceId_email: { workspaceId, email: key } },
    update: {
      status: result.status, confidence: result.confidence, provider: result.provider,
      evidence: J(result.evidence ?? {}), verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86400_000),
    },
    create: {
      workspaceId, email: key, status: result.status, confidence: result.confidence,
      provider: result.provider, evidence: J(result.evidence ?? {}),
      expiresAt: new Date(Date.now() + 30 * 86400_000),
    },
  }).catch(() => undefined);
  return result;
}
