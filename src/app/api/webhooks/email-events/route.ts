import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { db, J } from "@/lib/db";
import { withApi } from "@/lib/api";

// Provider delivery-event webhook (Resend/SendGrid/Postmark/SES/SMTP→forwarder):
// { provider, providerMessageId, event: delivered|bounced|opened|clicked|complained,
//   error? }. Secret-verified, idempotent, persists first, returns fast.
const EventSchema = z.object({
  provider: z.string(),
  providerMessageId: z.string(),
  event: z.enum(["delivered", "bounced", "opened", "clicked", "complained"]),
  error: z.string().optional(),
});

async function postHandler(req: Request) {
  const { webhookAuthSvix } = await import("@/lib/webhook-auth");
  const rawBody = await req.text();
  await webhookAuthSvix(req, "email-events", "RESEND_WEBHOOK_SECRET", rawBody);
  const claimed = Number(req.headers.get("content-length") ?? rawBody.length);
  if (claimed > 262_144 || rawBody.length > 262_144) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const body = EventSchema.parse(JSON.parse(rawBody));
  const msg = await db.message.findUnique({
    where: { providerMessageId: body.providerMessageId },
    include: { thread: { include: { lead: true } } },
  }).catch(() => null);
  if (!msg) return NextResponse.json({ ok: true, unmatched: true });
  // Idempotency: same event recorded already → ack without duplicating effects.
  const seen = await db.messageEvent.findFirst({
    where: { messageId: msg.id, type: `${body.provider}.${body.event}` },
  }).catch(() => null);
  if (seen) return NextResponse.json({ ok: true, deduped: true });
  await db.messageEvent.create({
    data: { messageId: msg.id, type: `${body.provider}.${body.event}`, payload: J({ error: body.error }) },
  });
  const leadId = msg.thread.leadId;
  if (body.event === "bounced" || body.event === "complained") {
    await db.message.update({ where: { id: msg.id }, data: { status: "bounced", error: body.error } });
    // Bounce only regresses pre-reply states: a bounced follow-up arriving
    // after the prospect already replied must not overwrite the reply.
    const current = await db.lead.findUnique({ where: { id: leadId }, select: { status: true } }).catch(() => null);
    if (current && ["READY_FOR_OUTREACH", "CONTACTED", "FOLLOW_UP"].includes(current.status)) {
      const { setLeadStatus } = await import("@/lib/state-machine");
      await setLeadStatus(leadId, "BOUNCED", { event: body.event }).catch(() => undefined);
    }
    await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "bounced" } }).catch(() => undefined);
    const email = msg.thread.lead.contactId
      ? (await db.contact.findUnique({ where: { id: msg.thread.lead.contactId } }).catch(() => null))?.email
      : null;
    if (email) {
      await db.suppression.create({
        data: { workspaceId: msg.thread.lead.workspaceId, email: email.toLowerCase(), reason: "bounced" },
      }).catch(() => undefined);
    }
    const { evaluateOperationalAlerts } = await import("@/lib/deliverability");
    await evaluateOperationalAlerts({ workspaceId: msg.thread.lead.workspaceId, leadId, trigger: body.event === "complained" ? "complaint" : "bounce" });
  } else if (body.event === "delivered") {
    if (msg.status === "sent") await db.message.update({ where: { id: msg.id }, data: { status: "delivered" } });
  }
  // opened/clicked are recorded as events (above) for analytics; status stays delivered.
  return NextResponse.json({ ok: true });
}

export const POST = withApi(postHandler);
