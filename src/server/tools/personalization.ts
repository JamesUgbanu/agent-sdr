import { z } from "zod";
import { db, J } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { canContactLead, assertNoFabrication } from "@/lib/policy";
import { getLLMProvider } from "@/lib/llm";
import { resolveModel } from "@/lib/models";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const generateMessageSchema = z.object({ leadId: z.string(), step: z.number().int().min(0).max(100).default(0) });

export async function generateMessage(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId, step } = args as { leadId: string; step: number };
  const lead = await db.lead.findUnique({ where: { id: leadId as string }, include: { campaign: true, company: true, contact: true } });
  if (!lead) throw new Error("lead not found");
  const contactable = await canContactLead(lead.id);
  if (!contactable.ok) throw new Error(`Draft blocked: ${contactable.reason}`);
  const research = await db.leadResearch.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
  const evidence = ((research?.evidence as Array<{ claim: string }>) ?? []).map((e) => e.claim);
  const llm = getLLMProvider();
  let draft: { subject: string; body: string; personalization_points: string[]; confidence: number; cta: string };
  const mc = await resolveModel("personalization", lead.workspaceId);
  try {
    draft = await llm.generateStructured(
      `Write concise B2B cold outreach (step ${step}). Campaign offer: ${lead.campaign.offer}. Value: ${lead.campaign.valueProposition}. Prospect: ${lead.contact?.fullName}, ${lead.contact?.title} at ${lead.company?.name}. Evidence (only use these facts, never invent): ${JSON.stringify(evidence)}. Return JSON {subject, body, personalization_points, confidence, cta}. No "Hope you're doing well". Max 120 words.`,
      null, { model: mc.model, temperature: mc.temperature ?? 0.4, tracking: { workspaceId: lead.workspaceId, campaignId: lead.campaignId, leadId: lead.id, task: "personalization" } },
    );
  } catch {
    // Deterministic evidence-backed fallback — never hallucinates signals.
    const hook = evidence[0] ? `Noticed: ${evidence[0]}.` : `${lead.company?.name ?? "Your team"} fits our ${lead.campaign.targetIndustries[0] ?? "SaaS"} ICP.`;
    draft = {
      subject: `Idea for ${lead.company?.name ?? "your team"} — ${lead.campaign.offer ?? "automation"}`,
      body: `Hi ${lead.contact?.firstName ?? "there"} — ${hook}\n\nWe help teams like yours with ${lead.campaign.valueProposition ?? lead.campaign.offer ?? "AI automation"}. Worth a 15-min look?\n\n— ${lead.campaign.senderName ?? "SDR"}`,
      personalization_points: evidence.slice(0, 2),
      confidence: evidence.length ? 0.75 : 0.45,
      cta: "15-min intro call",
    };
  }
  assertNoFabrication(draft.body, evidence);
  const idemKey = `${lead.id}-step-${step}`;
  const existing = await db.message.findUnique({ where: { idempotencyKey: idemKey } }).catch(() => null);
  if (existing) return { messageId: existing.id, status: existing.status, deduped: true };
  const thread = await db.messageThread.upsert({
    where: { id: `${lead.id}-main` },
    update: {},
    create: { id: `${lead.id}-main`, leadId: lead.id, subject: draft.subject, channel: "email" },
  }).catch(() => db.messageThread.create({ data: { leadId: lead.id, subject: draft.subject, channel: "email" } }));
  const gate = lead.campaign.approvalPolicy === "autonomous" || (lead.campaign.approvalPolicy === "assisted" && draft.confidence >= lead.campaign.approvalConfidenceThreshold);
  // Deliverability enforcement: a FAIL preflight downgrades autonomous
  // auto-approval to human review. Never silently sends on broken plumbing.
  let blockedReason: string | null = null;
  if (gate && lead.campaign.approvalPolicy === "autonomous") {
    const { latestPreflightVerdict } = await import("@/lib/deliverability");
    if ((await latestPreflightVerdict(lead.workspaceId).catch(() => null)) === "FAIL") {
      blockedReason = "deliverability preflight FAIL — autonomous sending blocked until resolved";
    }
  }
  const message = await db.message.create({
    data: {
      threadId: thread.id, direction: "outbound", subject: draft.subject, body: draft.body,
      personalizationPoints: draft.personalization_points,
      evidenceUsed: J(research?.evidence ?? {}),
      confidence: draft.confidence, status: gate && !blockedReason ? "approved" : "pending_approval",
      idempotencyKey: idemKey, sequenceStep: step as number,
    },
  }).catch(async (e) => {
    // Concurrent duplicate draft: return the winner instead of failing.
    if (String(e).includes("Unique constraint")) {
      const won = await db.message.findUnique({ where: { idempotencyKey: idemKey } }).catch(() => null);
      if (won) return won;
    }
    throw e;
  });
  if (!gate || blockedReason) {
    await db.approval.create({ data: { leadId: lead.id, messageId: message.id, status: "pending", reason: blockedReason ?? `confidence ${draft.confidence} < threshold` } });
    await emit("approval.requested", "Message awaiting human approval", { leadId: lead.id, campaignId: lead.campaignId });
  } else {
    await db.approval.create({ data: { leadId: lead.id, messageId: message.id, status: "auto_approved", reason: "policy gate passed" } });
    await enqueue("outreach", { leadId: lead.id, messageId: message.id });
  }
  return { messageId: message.id, status: message.status };
}

export const personalizationTools: Record<string, ToolDef> = {
  generateMessage: { schema: generateMessageSchema, fn: generateMessage, destructive: false },
};
