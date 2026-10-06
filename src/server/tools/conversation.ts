import { z } from "zod";
import { db, J } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { respondToProspect as respondToProspectLib } from "@/lib/conversation";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const respondToProspectSchema = z.object({ leadId: z.string(), prospectMessage: z.string().min(1) });

export async function respondToProspect(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId, prospectMessage } = args as { leadId: string; prospectMessage: string };
  const res = await respondToProspectLib(leadId as string, prospectMessage as string);
  const lead = await db.lead.findUnique({ where: { id: leadId as string } });
  // Conversational replies enter the approval queue unless the campaign is autonomous
  // AND the answer is knowledge-backed (not a handoff).
  const auto = lead?.campaignId && !res.approvalRequired && !res.handoff
    && (await db.campaign.findUnique({ where: { id: lead.campaignId } }))?.approvalPolicy === "autonomous";
  const thread = await db.messageThread.findFirst({ where: { leadId: leadId as string } });
  if (thread) {
    const msg = await db.message.create({
      data: {
        threadId: thread.id, direction: "outbound", subject: `Re: ${thread.subject ?? "follow-up"}`,
        body: res.reply, status: auto ? "approved" : "pending_approval",
        confidence: res.confidence, evidenceUsed: J({ knowledge: res.knowledgeUsed }),
        personalizationPoints: [], idempotencyKey: `${leadId}-convo-${Date.now()}`,
      },
    });
    await db.approval.create({
      data: {
        leadId: leadId as string, messageId: msg.id,
        status: auto ? "auto_approved" : "pending",
        reason: res.handoff ? `handoff: ${res.intent}` : `conversational reply (${res.intent}, conf ${res.confidence})`,
      },
    });
    if (auto) await enqueue("outreach", { leadId, messageId: msg.id });
  }
  await emit("conversation.replied", `${res.intent} (handoff=${res.handoff})`, { leadId: leadId as string, campaignId: lead?.campaignId }, res);
  return res;
}

export const conversationTools: Record<string, ToolDef> = {
  respondToProspect: { schema: respondToProspectSchema, fn: respondToProspect, destructive: false },
};
