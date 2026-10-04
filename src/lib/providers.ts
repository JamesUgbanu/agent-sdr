// Provider interfaces — add vendors without touching core agent logic.
export interface CompanySearchInput {
  industries?: string[]; geo?: string; sizeMin?: number; sizeMax?: number;
  technologies?: string[]; query?: string; limit?: number;
}
export interface CompanyResult {
  name: string; domain?: string; industry?: string; employeeCount?: number;
  location?: string; technologies?: string[]; description?: string;
}
export interface ContactSearchInput {
  companyDomain?: string; titles?: string[]; limit?: number;
}
export interface ContactResult {
  firstName?: string; lastName?: string; title?: string; email?: string;
  emailConfidence?: string; linkedinUrl?: string;
}
export interface ProspectProvider {
  name: string;
  searchCompanies(input: CompanySearchInput): Promise<CompanyResult[]>;
  searchContacts(input: ContactSearchInput): Promise<ContactResult[]>;
}

// Internal ICP-driven stub generator (deterministic, clearly labeled — for tests/dev only).
export class InternalSeedProvider implements ProspectProvider {
  name = "internal-seed";
  async searchCompanies(input: CompanySearchInput): Promise<CompanyResult[]> {
    const n = Math.min(input.limit ?? 5, 10);
    return Array.from({ length: n }, (_, i) => ({
      name: `${input.query ?? "Acme"} ${i + 1}`,
      domain: `acme${i + 1}.example.com`,
      industry: input.industries?.[0] ?? "SaaS",
      employeeCount: 80,
      location: input.geo ?? "United States",
    }));
  }
  async searchContacts(input: ContactSearchInput): Promise<ContactResult[]> {
    const titles = input.titles?.length ? input.titles : ["CTO"];
    return titles.slice(0, 3).map((t, i) => ({
      firstName: ["Sarah", "James", "Priya"][i] ?? "Alex",
      lastName: "Chen",
      title: t,
      linkedinUrl: undefined,
    }));
  }
}

export interface OutboundMessage {
  to: string; subject: string; body: string; replyTo?: string;
  idempotencyKey: string; threadId?: string;
}
export interface SendResult { providerMessageId: string; status: string; }
export interface MessageStatus {
  messageId: string; status: string; deliveredAt?: string; openedAt?: string;
  clickedAt?: string; bouncedAt?: string; error?: string;
}
export interface OutreachChannel {
  name: string;
  send(m: OutboundMessage): Promise<SendResult>;
  getStatus(messageId: string): Promise<MessageStatus>;
}

export interface CRMProvider {
  name: string;
  upsertContact(a: { email: string; name?: string; company?: string }): Promise<string | void>;
  updateContact(a: { externalId: string; fields: Record<string, string> }): Promise<void>;
  addNote(a: { email: string; note: string }): Promise<string | void>;
  createDeal(a: { email: string; title: string; amount?: number; stage?: string }): Promise<string | void>;
  createActivity(a: { email: string; type: string; body: string }): Promise<string | void>;
}
export interface Availability { start: string; end: string; }
export interface MeetingInput {
  title: string; start: string; end: string; attendee: string;
  description?: string; timezone?: string; leadId?: string;
}
export interface CalendarProvider {
  name: string;
  getAvailability(opts?: { durationMin?: number; from?: string; to?: string; timezone?: string }): Promise<Availability[]>;
  createMeeting(i: MeetingInput): Promise<{ id: string }>;
  cancelMeeting(id: string): Promise<void>;
}

// Email deliverability verification. Implementations must never fabricate results:
// without a configured provider they return { status: "unavailable" }.
export interface VerificationResult {
  status: "deliverable" | "risky" | "undeliverable" | "unknown" | "unavailable";
  confidence: number | null;
  provider: string;
  evidence?: Record<string, unknown>;
  checkedAt: string;
}
export interface EmailVerificationProvider {
  name: string;
  verify(email: string): Promise<VerificationResult>;
}
