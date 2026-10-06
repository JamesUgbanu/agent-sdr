import { z } from "zod";
import { db, J } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { canContactLead } from "@/lib/policy";
import { withinWorkingHours } from "@/lib/policy";
import { setLeadStatus } from "@/lib/state-machine";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const sendEmailSchema = z.object({ messageId: z.string() });

export async function sendEmail(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { messageId } = args as { messageId: string };
  const msg = await db.message.findUnique({ where: { id: messageId as string }, include: { thread: { include: { lead: { include: { campaign: true, contact: true } } } } } });
  if (!msg) throw new Error("message not found");
  const lead = msg.thread.lead;
  const gate = await canContactLead(lead.id);
  if (!gate.ok) throw new Error(`Send blocked: ${gate.reason}`);
  // Outreach is only valid once the lead has entered the sequence.
  if (!["READY_FOR_OUTREACH", "CONTACTED", "FOLLOW_UP"].includes(lead.status)) {
    throw new Error(`Send blocked: lead is ${lead.status}, not in an outreach state`);
  }
  // Idempotency: exact step already sent?
  const dup = await db.message.findFirst({ where: { providerMessageId: { not: null }, thread: { leadId: lead.id }, sequenceStep: msg.sequenceStep, status: { in: ["sent", "delivered"] } } });
  if (dup) return { skipped: true, reason: "already-sent", providerMessageId: dup.providerMessageId };
  const to = lead.contact?.email;
  if (!to) throw new Error("No recipient email — never invent contact info");
  // Daily limit check
  const dayAgo = new Date(Date.now() - 86400_000);
  const sentToday = await db.message.count({ where: { thread: { lead: { campaignId: lead.campaignId } }, status: { in: ["sent", "delivered"] }, sentAt: { gte: dayAgo } } });
  if (sentToday >= lead.campaign.dailySendLimit) throw new Error("daily-send-limit reached");
  try {
    // Atomic claim: only one worker can move this message into sending.
    // Concurrent senders lose the race here instead of double-sending.
    // A message stuck in "sending" (crashed worker) is deliberately NOT
    // claimable: provider state must be reconciled before any resend.
    const claim = await db.message.updateMany({
      where: { id: msg.id, status: { in: ["approved", "failed"] } },
      data: { status: "sending" },
    });
    if (claim.count === 0) {
      const current = await db.message.findUnique({ where: { id: msg.id } }).catch(() => null);
      if (current && ["sent", "delivered"].includes(current.status)) {
        return { skipped: true, reason: "already-sent", providerMessageId: current.providerMessageId };
      }
      throw new Error(`Send conflict: message is ${current?.status ?? "gone"} — reconcile provider state before resending`);
    }
    const { workspaceChannel, sendWithFallback } = await import("@/lib/email");
    // Workspace connection credentials win; env chain remains as fallback.
    const ws = await workspaceChannel(lead.workspaceId);
    const res = await sendWithFallback(
      { to, subject: msg.subject ?? "", body: msg.body, idempotencyKey: msg.idempotencyKey ?? msg.id },
      undefined, ws?.name, ws?.channel,
    );
    await db.message.update({ where: { id: msg.id }, data: { status: "sent", providerMessageId: res.providerMessageId, sentAt: new Date() } });
    await setLeadStatus(lead.id, lead.status === "READY_FOR_OUTREACH" ? "CONTACTED" : "FOLLOW_UP", { messageId: msg.id });
    // Schedule next sequence step
    const seq = await db.sequence.findFirst({ where: { campaignId: lead.campaignId }, include: { steps: { orderBy: { order: "asc" } } } });
    const nextIdx = (msg.sequenceStep ?? 0) + 1;
    const nextStep = seq?.steps[nextIdx];
    if (nextStep) {
      await db.leadSequenceState.upsert({
        where: { leadId: lead.id },
        update: { currentStep: nextIdx, nextRunAt: new Date(Date.now() + nextStep.dayOffset * 86400_000) },
        create: { leadId: lead.id, sequenceId: seq!.id, currentStep: nextIdx, nextRunAt: new Date(Date.now() + nextStep.dayOffset * 86400_000) },
      });
      await enqueue("personalization", { leadId: lead.id }, { delayMs: Math.min(nextStep.dayOffset * 86400_000, 60_000) });
    }
    await emit("email.sent", `Email sent to ${to}`, { leadId: lead.id, campaignId: lead.campaignId }, { providerMessageId: res.providerMessageId });
    return res;
  } catch (e) {
    // Do NOT blindly retry non-idempotent send: reconcile first.
    await db.message.update({ where: { id: msg.id }, data: { status: "failed", error: String(e) } });
    const { evaluateOperationalAlerts } = await import("@/lib/deliverability");
    await evaluateOperationalAlerts({ workspaceId: lead.workspaceId, leadId: lead.id, trigger: "send_failure" });
    throw e;
  }
}

export const scheduleFollowUpSchema = z.object({ leadId: z.string(), dayOffset: z.number().min(0).max(30).default(3) });

export async function scheduleFollowUp(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId, dayOffset } = args as { leadId: string; dayOffset: number };
  const lead = await db.lead.findUnique({
    where: { id: leadId as string }, include: { campaign: true, sequenceState: true },
  });
  if (!lead) throw new Error("lead not found");
  if (["REPLIED", "MEETING_REQUESTED", "MEETING_BOOKED", "NOT_INTERESTED", "UNSUBSCRIBED", "BOUNCED", "DISQUALIFIED", "DO_NOT_CONTACT"].includes(lead.status)) {
    throw new Error(`Follow-up blocked: lead is ${lead.status}`);
  }
  const gate = await canContactLead(lead.id);
  if (!gate.ok) throw new Error(`Follow-up blocked: ${gate.reason}`);
  const nextRunAt = new Date(Date.now() + (dayOffset as number) * 86400_000);
  if (!withinWorkingHours(lead.campaign.timezone, lead.campaign.workingHoursStart, lead.campaign.workingHoursEnd, nextRunAt)) {
    nextRunAt.setUTCHours(10, 0, 0, 0); // shift into working hours instead of sending at night
  }
  const key = `${lead.id}-followup-${lead.sequenceState?.currentStep ?? 0}`;
  if (lead.sequenceState?.nextRunAt && lead.sequenceState.nextRunAt > new Date()) {
    return { skipped: true, reason: "already-scheduled", nextRunAt: lead.sequenceState.nextRunAt };
  }
  const seqId = lead.sequenceState?.sequenceId
    ?? (await db.sequence.findFirst({ where: { campaignId: lead.campaignId } }))?.id;
  await db.leadSequenceState.upsert({
    where: { leadId: lead.id },
    update: { nextRunAt },
    create: { leadId: lead.id, sequenceId: seqId, currentStep: 0, nextRunAt },
  });
  const delayMs = nextRunAt.getTime() - Date.now();
  await enqueue("personalization", { leadId: lead.id }, { delayMs, idempotencyKey: key, workspaceId: lead.workspaceId });
  await emit("followup.scheduled", `Follow-up scheduled for ${nextRunAt.toISOString()}`, { leadId: lead.id, campaignId: lead.campaignId });
  return { scheduled: true, nextRunAt: nextRunAt.toISOString() };
}

export const outreachTools: Record<string, ToolDef> = {
  sendEmail: { schema: sendEmailSchema, fn: sendEmail, destructive: true },
  scheduleFollowUp: { schema: scheduleFollowUpSchema, fn: scheduleFollowUp, destructive: false },
};
