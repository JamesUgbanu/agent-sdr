import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { db } from "@/lib/db";
import { withApi } from "@/lib/api";

// Inbound email webhook: validate → persist → queue. Never run the agent inline.
async function postHandler(req: Request) {
  const { webhookAuth } = await import("@/lib/webhook-auth");
  await webhookAuth(req, "email-inbound");
  // Payload size guard: inbound email bodies have no business exceeding 256KB.
  const claimed = Number(req.headers.get("content-length") ?? 0);
  if (claimed > 262_144) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const body = await req.json() as { from?: string; subject?: string; body?: string; providerMessageId?: string; inReplyTo?: string };
  if (typeof body.body === "string" && body.body.length > 262_144) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }
  if (!body.from || !body.body) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  // Idempotency on provider id
  if (body.providerMessageId) {
    const dup = await db.message.findUnique({ where: { providerMessageId: body.providerMessageId } }).catch(() => null);
    if (dup) return NextResponse.json({ ok: true, deduped: true });
  }
  // Thread match: reply-to provider id, else latest contacted lead by email
  let thread = body.inReplyTo
    ? await db.messageThread.findFirst({ where: { messages: { some: { providerMessageId: body.inReplyTo } } } })
    : null;
  if (!thread) {
    const contact = await db.contact.findFirst({ where: { email: { equals: body.from, mode: "insensitive" } } });
    const lead = contact ? await db.lead.findFirst({ where: { contactId: contact.id }, orderBy: { updatedAt: "desc" } }) : null;
    if (!lead) return NextResponse.json({ ok: true, unmatched: true });
    thread = await db.messageThread.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
  }
  if (!thread) return NextResponse.json({ ok: true, unmatched: true });
  // Replay protection for forwarders that omit providerMessageId: the same
  // body on the same thread within 10 minutes is treated as a redelivery.
  const { createHash } = await import("crypto");
  const fingerprint = createHash("sha256").update(`${body.from ?? ""}|${body.subject ?? ""}|${body.body}`).digest("hex");
  const recent = await db.message.findMany({
    where: { threadId: thread.id, direction: "inbound", createdAt: { gte: new Date(Date.now() - 600_000) } },
    take: 20,
  }).catch(() => []);
  for (const m of recent) {
    const h = createHash("sha256").update(`${body.from ?? ""}|${m.subject ?? ""}|${m.body}`).digest("hex");
    if (h === fingerprint) return NextResponse.json({ ok: true, deduped: true });
  }
  const inbound = await db.message.create({
    data: { threadId: thread.id, direction: "inbound", subject: body.subject, body: body.body, status: "replied", providerMessageId: body.providerMessageId },
  });
  const { enqueue } = await import("@/lib/queue");
  await enqueue("reply", { messageId: inbound.id, leadId: thread.leadId });
  return NextResponse.json({ ok: true, messageId: inbound.id });
}

export const POST = withApi(postHandler);
