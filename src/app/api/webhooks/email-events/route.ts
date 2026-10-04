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
  const { safeEqual } = await import("@/lib/crypto");
  const secret = req.headers.get("x-webhook-secret");
  if (process.env.EMAIL_WEBHOOK_SECRET && !safeEqual(secret, process.env.EMAIL_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const claimed = Number(req.headers.get("content-length") ?? 0);
  if (claimed > 262_144) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const body = EventSchema.parse(await req.json());
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
    await db.lead.update({ where: { id: leadId }, data: { status: "BOUNCED" } }).catch(() => undefined);
    await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "bounced" } }).catch(() => undefined);
    const email = msg.thread.lead.contactId
      ? (await db.contact.findUnique({ where: { id: msg.thread.lead.contactId } }).catch(() => null))?.email
      : null;
    if (email) {
      await db.suppression.create({
        data: { workspaceId: msg.thread.lead.workspaceId, email: email.toLowerCase(), reason: "bounced" },
      }).catch(() => undefined);
    }
  } else if (body.event === "delivered") {
    if (msg.status === "sent") await db.message.update({ where: { id: msg.id }, data: { status: "delivered" } });
  }
  // opened/clicked are recorded as events (above) for analytics; status stays delivered.
  return NextResponse.json({ ok: true });
}

export const POST = withApi(postHandler);
