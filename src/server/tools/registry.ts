import type { z } from "zod";
import type { ToolCatalogEntry } from "@/lib/llm";
import { zodToJsonSchema } from "@/lib/tool-schema";
import { prospectingTools } from "./prospecting";
import { researchTools } from "./research";
import { qualificationTools } from "./qualification";
import { personalizationTools } from "./personalization";
import { outreachTools } from "./outreach";
import { repliesTools } from "./replies";
import { crmTools } from "./crm";
import { calendarTools } from "./calendar";
import { conversationTools } from "./conversation";

// ── Tool registry: the ONLY way the LLM touches the world ──
// Execution path (never bypassed):
//   LLM decision → validated tool name → permission check → scope check
//   → tool registry → deterministic application code → integration/database
// The LLM NEVER directly calls an integration or database operation.

// Run-scoped identity handed to every tool call.
export interface ToolContext {
  leadId?: string;
  campaignId?: string;
}

export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface ToolDef {
  schema: z.ZodTypeAny;
  fn: ToolFn;
  // Destructive/irreversible tools (sends, bookings, cancels) get extra
  // scrutiny: approval gates, claim validation, and idempotency live in the
  // implementations, marked here for auditability.
  destructive: boolean;
}

export const tools: Record<string, ToolDef> = {
  ...prospectingTools,
  ...researchTools,
  ...qualificationTools,
  ...personalizationTools,
  ...outreachTools,
  ...repliesTools,
  ...crmTools,
  ...calendarTools,
  ...conversationTools,
};

// Tools the run may choose from, per run type. This is a PERMISSION SET, not a
// sequence: the LLM decides order, repetition, and termination within it.
export const ALLOWED_TOOLS: Record<string, string[]> = {
  prospecting: ["searchProspects"],
  enrichment: ["verifyEmail", "researchCompany"],
  research: ["researchCompany"],
  qualification: ["scoreLead"],
  personalization: ["generateMessage"],
  outreach: ["sendEmail", "updateCRM"],
  reply: ["classifyReply"],
  followup: ["scheduleFollowUp"],
  crm: ["updateCRM"],
  meeting: ["checkCalendarAvailability", "scheduleMeeting", "cancelMeeting"],
  conversation: ["respondToProspect"],
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  searchProspects: "Discover companies and decision-maker contacts matching the campaign ICP; creates leads.",
  verifyEmail: "Check deliverability of the lead's email address. Returns explicit unavailable when unconfigured.",
  researchCompany: "Fetch and store evidence-backed company research and buying signals (cached per workspace).",
  scoreLead: "Compute the explained ICP-fit score and route qualified leads onward.",
  generateMessage: "Draft evidence-backed outreach. Low-confidence drafts require human approval.",
  sendEmail: "Send an approved message. Enforces suppression, limits, working hours, idempotency.",
  classifyReply: "Classify an inbound reply and apply stop/route/suppress rules.",
  scheduleFollowUp: "Schedule the next sequence step honoring limits, hours, and idempotency.",
  updateCRM: "Sync lead/contact/deal/activity to the configured CRM with a persisted ledger.",
  checkCalendarAvailability: "Return real availability slots. Never invents times.",
  scheduleMeeting: "Book a meeting only inside verified availability; prevents duplicates.",
  cancelMeeting: "Cancel a booked meeting provider-side and locally.",
  respondToProspect: "Draft a knowledge-grounded reply; hands off when knowledge is insufficient.",
};

export function toolCatalog(allowed: string[]): ToolCatalogEntry[] {
  return allowed
    .filter((n) => tools[n])
    .map((n) => ({ name: n, description: TOOL_DESCRIPTIONS[n] ?? n, argsSchema: zodToJsonSchema(tools[n]!.schema) }));
}
