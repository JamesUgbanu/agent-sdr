import { z } from "zod";
import { db, J } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { scoreLead, WeightsSchema } from "@/lib/scoring";
import { setLeadStatus } from "@/lib/state-machine";
import { verifyEmailCached } from "@/lib/integrations";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const scoreLeadSchema = z.object({ leadId: z.string() });

export async function scoreLeadTool(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId } = args as { leadId: string };
  const lead = await db.lead.findUnique({ where: { id: leadId as string }, include: { campaign: true, company: true, contact: true, signals: true } });
  if (!lead) throw new Error("lead not found");
  const weights = WeightsSchema.parse((lead.campaign.scoringWeights as object) ?? {});
  const signalStrength = Math.min(1, lead.signals.length * 0.3);
  const { score, factors } = scoreLead({
    companyMatch: lead.company ? 0.8 : 0.3,
    roleMatch: lead.contact?.title && lead.campaign.jobTitles.some((t: string) => lead.contact!.title!.toLowerCase().includes(t.toLowerCase().split(" ")[0] ?? t.toLowerCase())) ? 1 : 0.5,
    geoMatch: 0.8, intentMatch: 0.6, signalStrength,
    dataConfidence: lead.contact?.emailConfidence === "verified" ? 1 : 0.5,
  }, weights);
  await db.leadScore.create({ data: { leadId: lead.id, score, breakdown: J(factors), reasoning: "Deterministic weighted factors; no black-box LLM score.", evidence: J({ signals: lead.signals.length }) } });
  const next = score >= lead.campaign.minScoreToContact ? "READY_FOR_OUTREACH" : "DISQUALIFIED";
  // Never regress post-outreach states: re-scoring a CONTACTED/replied lead
  // records the score but leaves the conversation state untouched.
  const preOutreach = ["NEW", "RESEARCHING", "QUALIFIED", "READY_FOR_OUTREACH"].includes(lead.status);
  await db.lead.update({ where: { id: lead.id }, data: { score, scoreBreakdown: J(factors), scoreReasoning: `score=${score}` } });
  if (preOutreach) await setLeadStatus(lead.id, next, { score });
  await emit("lead.scored", `Scored ${score}: ${JSON.stringify(factors)}`, { leadId: lead.id, campaignId: lead.campaignId });
  if (next === "READY_FOR_OUTREACH") await enqueue("personalization", { leadId: lead.id });
  return { score, factors };
}

export const verifyEmailSchema = z.object({ leadId: z.string() });

export async function verifyEmailTool(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId } = args as { leadId: string };
  const lead = await db.lead.findUnique({
    where: { id: leadId as string }, include: { contact: true },
  });
  if (!lead?.contact?.email) throw new Error("No email to verify — never invent contact info");
  const result = await verifyEmailCached(lead.workspaceId, lead.contact.email);
  await db.contact.update({
    where: { id: lead.contact.id },
    data: {
      emailConfidence: result.status === "deliverable" ? "verified"
        : result.status === "undeliverable" ? "low"
        : result.status === "unavailable" ? "unknown" : "medium",
    },
  }).catch(() => undefined);
  await emit("email.verified", `${lead.contact.email}: ${result.status}`, { leadId: lead.id, campaignId: lead.campaignId }, result);
  return result;
}

export const qualificationTools: Record<string, ToolDef> = {
  scoreLead: { schema: scoreLeadSchema, fn: scoreLeadTool, destructive: false },
  verifyEmail: { schema: verifyEmailSchema, fn: verifyEmailTool, destructive: false },
};
