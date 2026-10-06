import { z } from "zod";
import { db, J } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { setLeadStatus } from "@/lib/state-machine";
import { getLLMProvider } from "@/lib/llm";
import { resolveModel } from "@/lib/models";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const classifyReplySchema = z.object({ messageId: z.string() });

export async function classifyReply(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { messageId } = args as { messageId: string };
  const msg = await db.message.findUnique({ where: { id: messageId as string }, include: { thread: { include: { lead: true } } } });
  if (!msg) throw new Error("message not found");
  const text = msg.body.toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["unsubscribe", /unsubscribe|remove me|do not (contact|email)/],
    ["not_interested", /not interested|no thanks|pass|not a (fit|priority)/],
    ["out_of_office", /out of office|ooo|on leave|auto.?reply/],
    ["meeting_request", /let'?s (meet|talk|chat)|book|calendar|tuesday|wednesday|call (tomorrow|next week)/],
    ["pricing_question", /how much|pricing|cost|quote/],
    ["referral", /talk to .*@|contact (my|our) colleague|forward/],
    ["interested", /interested|tell me more|sounds (good|great)|let'?s explore/],
  ];
  let classification = "unclear", confidence = 0.4;
  for (const [c, re] of rules) {
    if (re.test(text)) { classification = c; confidence = c === "unclear" ? 0.4 : 0.85; break; }
  }
  try {
    const llm = getLLMProvider();
    if (llm.name !== "console") {
      const mc = await resolveModel("classification", msg.thread.lead.workspaceId);
      const r = await llm.generateStructured<{ classification: string; confidence: number; reason: string }>(
        `Classify this sales reply into [interested, meeting_request, question, not_interested, unsubscribe, out_of_office, wrong_person, referral, pricing_question, objection, unclear]. Reply: """${msg.body.slice(0, 2000)}""" Return JSON {classification, confidence, reason}.`,
        null, { model: mc.model, temperature: 0, tracking: { workspaceId: msg.thread.lead.workspaceId, campaignId: msg.thread.lead.campaignId, leadId: msg.thread.leadId, task: "classification" } },
      );
      classification = r.classification; confidence = r.confidence;
      const known = ["interested", "meeting_request", "question", "not_interested", "unsubscribe", "out_of_office", "wrong_person", "referral", "pricing_question", "objection", "unclear"];
      if (!known.includes(classification)) { classification = "unclear"; confidence = Math.min(confidence, 0.4); }
    }
  } catch { /* rule fallback stands */ }
  const requiresHuman = confidence < 0.65 || classification === "unclear";
  await db.message.update({ where: { id: msg.id }, data: { classification, classificationConfidence: confidence } });
  const leadId = msg.thread.leadId;
  if (classification === "unsubscribe") {
    const lead = await db.lead.findUnique({ where: { id: leadId }, include: { contact: true } });
    if (lead?.contact?.email) {
      await db.suppression.upsert({
        where: { id: `${lead.workspaceId}-${lead.contact.email}` },
        update: {}, create: { id: `${lead.workspaceId}-${lead.contact.email}`, workspaceId: lead.workspaceId, email: lead.contact.email.toLowerCase(), reason: "unsubscribed" },
      }).catch(() => db.suppression.create({ data: { workspaceId: lead!.workspaceId, email: lead!.contact!.email!.toLowerCase(), reason: "unsubscribed" } }));
    }
    await setLeadStatus(leadId, "UNSUBSCRIBED", { classification });
    await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "unsubscribed" } }).catch(() => undefined);
  } else if (classification === "not_interested") {
    await setLeadStatus(leadId, "NOT_INTERESTED", { classification });
    await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "not-interested" } }).catch(() => undefined);
  } else if (classification === "interested" || classification === "meeting_request") {
    await setLeadStatus(leadId, "MEETING_REQUESTED", { classification });
    await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "replied-positive" } }).catch(() => undefined);
    await enqueue("meeting", { leadId });
  } else if (requiresHuman) {
    // Human handoff with full brief: reviewer gets everything needed to decide.
    const brief = await db.lead.findUnique({
      where: { id: leadId }, include: { contact: true, company: true, scores: { orderBy: { createdAt: "desc" }, take: 1 } },
    }).catch(() => null);
    await db.agentTask.create({
      data: {
        leadId, type: "review_reply", status: "open",
        payload: J({
          messageId, classification, confidence,
          replyExcerpt: msg.body.slice(0, 500),
          prospect: brief?.contact ? { name: brief.contact.fullName, title: brief.contact.title, email: brief.contact.email } : undefined,
          company: brief?.company ? { name: brief.company.name, domain: brief.company.domain } : undefined,
          score: brief?.score ?? brief?.scores?.[0]?.score ?? undefined,
        }),
      },
    });
    if (["question", "pricing_question", "objection"].includes(classification)) {
      // Draft a knowledge-grounded response into the approval queue; human decides.
      await enqueue("conversation", { leadId, prospectMessage: msg.body.slice(0, 2000) });
    }
  } else {
    // Non-terminal reply (question, OOO, referral...): record the reply and
    // stop the sequence, but never overwrite a further-advanced state
    // (e.g. MEETING_REQUESTED from an earlier message in the thread).
    try {
      await setLeadStatus(leadId, "REPLIED", { classification });
    } catch (e) {
      // Already past REPLIED (e.g. MEETING_REQUESTED): keep the more
      // advanced state. Anything else is a real failure — surface it.
      if (!String(e).startsWith("Illegal transition")) throw e;
    }
    await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "replied" } }).catch(() => undefined);
    if (["question", "pricing_question", "objection"].includes(classification)) {
      // High-confidence questions still deserve an answer: draft a
      // knowledge-grounded response into the approval queue.
      await enqueue("conversation", { leadId, prospectMessage: msg.body.slice(0, 2000) });
    }
  }
  await emit("reply.classified", `${classification} (${confidence})`, { leadId, campaignId: msg.thread.lead.campaignId });
  return { classification, confidence, requiresHuman };
}

export const repliesTools: Record<string, ToolDef> = {
  classifyReply: { schema: classifyReplySchema, fn: classifyReply, destructive: false },
};
