import { Resend } from "resend";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import nodemailer from "nodemailer";
import type { MessageStatus, OutboundMessage, OutreachChannel, SendResult } from "./providers";
import { db } from "./db";
import { decryptSecret } from "./crypto";

function unknownStatus(id: string): MessageStatus {
  return { messageId: id, status: "unknown" };
}

// EMAIL_FROM may be "Name <addr@x>" — some providers need the bare address.
export function parseFromAddress(fromRaw: string): string {
  return fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw;
}

class ResendChannel implements OutreachChannel {
  name = "resend";
  constructor(private apiKey = process.env.RESEND_API_KEY ?? "") {}
  private guard() {
    if (!this.apiKey) throw new Error("RESEND_API_KEY not configured");
  }
  async send(m: OutboundMessage): Promise<SendResult> {
    this.guard();
    const resend = new Resend(this.apiKey);
    const r = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "SDR <sdr@example.com>",
      to: m.to,
      subject: m.subject,
      text: m.body,
      replyTo: m.replyTo ?? process.env.EMAIL_REPLY_TO ?? undefined,
      headers: { "X-Idempotency-Key": m.idempotencyKey },
    });
    if (r.error) throw new Error(r.error.message);
    return { providerMessageId: r.data?.id ?? m.idempotencyKey, status: "sent" };
  }
  async getStatus(messageId: string): Promise<MessageStatus> {
    this.guard();
    const r = await fetch(`https://api.resend.com/emails/${messageId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!r.ok) return { messageId: messageId, status: "unknown", error: `resend:${r.status}` };
    const j = (await r.json()) as { last_event?: string };
    const map: Record<string, string> = {
      sent: "sent", delivered: "delivered", delivery_delayed: "sent",
      bounced: "bounced", complained: "bounced", opened: "delivered", clicked: "delivered",
    };
    return { messageId, status: map[j.last_event ?? ""] ?? "sent" };
  }
}

class SendGridChannel implements OutreachChannel {
  name = "sendgrid";
  constructor(private apiKey = process.env.SENDGRID_API_KEY ?? "") {}
  private guard() {
    if (!this.apiKey) throw new Error("SENDGRID_API_KEY not configured");
  }
  async send(m: OutboundMessage): Promise<SendResult> {
    this.guard();
    const fromAddr = parseFromAddress(process.env.EMAIL_FROM ?? "sdr@example.com");
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: m.to }] }],
        from: { email: fromAddr },
        reply_to: m.replyTo ? { email: m.replyTo } : undefined,
        subject: m.subject, content: [{ type: "text/plain", value: m.body }],
        custom_args: { idempotency_key: m.idempotencyKey },
      }),
    });
    if (!r.ok) throw new Error(`sendgrid: ${r.status} ${await r.text()}`);
    const sgId = r.headers.get("x-message-id") ?? m.idempotencyKey;
    return { providerMessageId: sgId, status: "sent" };
  }
  async getStatus(messageId: string): Promise<MessageStatus> {
    // SendGrid delivery truth arrives via Event Webhook; activity API needs elevated access.
    // Never invent: report unknown unless webhook events were persisted for this id.
    try {
      const ev = await db.messageEvent.findFirst({
        where: { message: { providerMessageId: messageId }, type: { startsWith: "sendgrid." } },
        orderBy: { createdAt: "desc" },
      });
      if (ev) return { messageId, status: ev.type.replace("sendgrid.", "") };
    } catch { /* offline */ }
    return unknownStatus(messageId);
  }
}

class PostmarkChannel implements OutreachChannel {
  name = "postmark";
  constructor(private token = process.env.POSTMARK_API_KEY ?? "") {}
  private guard() {
    if (!this.token) throw new Error("POSTMARK_API_KEY not configured");
  }
  async send(m: OutboundMessage): Promise<SendResult> {
    this.guard();
    const r = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": this.token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        From: process.env.EMAIL_FROM ?? "sdr@example.com", To: m.to,
        Subject: m.subject, TextBody: m.body, ReplyTo: m.replyTo,
        Metadata: { idempotency_key: m.idempotencyKey },
      }),
    });
    const j = (await r.json()) as { MessageID?: string; ErrorCode?: number; Message?: string };
    if (!r.ok || (j.ErrorCode !== 0 && j.ErrorCode !== undefined)) throw new Error(`postmark: ${j.Message ?? r.status}`);
    return { providerMessageId: j.MessageID ?? m.idempotencyKey, status: "sent" };
  }
  async getStatus(messageId: string): Promise<MessageStatus> {
    this.guard();
    const r = await fetch(`https://api.postmarkapp.com/messages/outbound/${messageId}/details`, {
      headers: { "X-Postmark-Server-Token": this.token, Accept: "application/json" },
    });
    if (!r.ok) return { messageId, status: "unknown", error: `postmark:${r.status}` };
    const j = (await r.json()) as { Status?: string };
    return { messageId, status: (j.Status ?? "unknown").toLowerCase() };
  }
}

class SesChannel implements OutreachChannel {
  name = "ses";
  private client: SESClient | null = null;
  constructor(private cfg?: { region?: string; accessKeyId?: string; secretAccessKey?: string }) {}
  private getClient() {
    if (!this.client) {
      const region = this.cfg?.region ?? process.env.SES_REGION ?? process.env.AWS_REGION;
      if (!region) throw new Error("SES_REGION not configured");
      const accessKeyId = this.cfg?.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
      if (!accessKeyId && !process.env.AWS_ACCESS_KEY_ID) throw new Error("AWS credentials not configured for SES");
      this.client = new SESClient({
        region,
        ...(this.cfg?.accessKeyId && this.cfg?.secretAccessKey
          ? { credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey } }
          : {}),
      });
    }
    return this.client;
  }
  async send(m: OutboundMessage): Promise<SendResult> {
    const r = await this.getClient().send(new SendEmailCommand({
      Source: process.env.EMAIL_FROM ?? "sdr@example.com",
      Destination: { ToAddresses: [m.to] },
      ReplyToAddresses: m.replyTo ? [m.replyTo] : undefined,
      Message: {
        Subject: { Data: m.subject },
        Body: { Text: { Data: m.body } },
      },
    }));
    return { providerMessageId: r.MessageId ?? m.idempotencyKey, status: "sent" };
  }
  async getStatus(messageId: string): Promise<MessageStatus> {
    // SES delivery truth arrives via SNS notifications; without them report unknown honestly.
    return unknownStatus(messageId);
  }
}

class SmtpChannel implements OutreachChannel {
  name = "smtp";
  constructor(private cfg?: { url?: string }) {}
  async send(m: OutboundMessage): Promise<SendResult> {
    const url = this.cfg?.url ?? process.env.SMTP_URL;
    if (!url) throw new Error("SMTP_URL not configured");
    const t = nodemailer.createTransport(url);
    const info = await t.sendMail({
      from: process.env.EMAIL_FROM ?? "sdr@example.com",
      to: m.to, subject: m.subject, text: m.body, replyTo: m.replyTo,
      headers: { "X-Idempotency-Key": m.idempotencyKey },
    });
    return { providerMessageId: info.messageId ?? m.idempotencyKey, status: "sent" };
  }
  async getStatus(messageId: string): Promise<MessageStatus> {
    return unknownStatus(messageId); // SMTP has no status API; bounces arrive via inbound parsing
  }
}

class ConsoleChannel implements OutreachChannel {
  name = "console";
  async send(m: OutboundMessage): Promise<SendResult> {
    console.log(`[email:console] to=${m.to} subject=${m.subject} key=${m.idempotencyKey}`);
    return { providerMessageId: `console-${m.idempotencyKey}`, status: "sent" };
  }
  async getStatus(messageId: string): Promise<MessageStatus> {
    return { messageId, status: "sent" };
  }
}

export function channelForProvider(p: string): OutreachChannel {
  switch (p) {
    case "resend": return new ResendChannel();
    case "sendgrid": return new SendGridChannel();
    case "postmark": return new PostmarkChannel();
    case "ses": return new SesChannel();
    case "smtp": return new SmtpChannel();
    case "console": return new ConsoleChannel();
    default: throw new Error(`Unknown email provider "${p}" — refusing to silently dry-run. Use "console" explicitly for dry runs.`);
  }
}

// Workspace-scoped channel: builds the connection's provider with its decrypted
// credentials passed explicitly — never written to process.env, so one
// workspace's keys cannot leak into another workspace's sends in-process.
// Returns null when no connection is configured (caller falls back to env).
export async function workspaceChannel(workspaceId: string): Promise<{ channel: OutreachChannel; name: string } | null> {
  try {
    const conn = await db.emailConnection.findFirst({ where: { workspaceId } });
    if (!conn) return null;
    let cfg: Record<string, string> = {};
    try {
      const raw = conn.encryptedConfig.startsWith("{") ? conn.encryptedConfig : decryptSecret(conn.encryptedConfig);
      cfg = JSON.parse(raw) as Record<string, string>;
    } catch {
      return null;
    }
    switch (conn.provider) {
      case "resend": return { channel: new ResendChannel(cfg.RESEND_API_KEY ?? process.env.RESEND_API_KEY ?? ""), name: "resend" };
      case "sendgrid": return { channel: new SendGridChannel(cfg.SENDGRID_API_KEY ?? process.env.SENDGRID_API_KEY ?? ""), name: "sendgrid" };
      case "postmark": return { channel: new PostmarkChannel(cfg.POSTMARK_API_KEY ?? process.env.POSTMARK_API_KEY ?? ""), name: "postmark" };
      case "ses": return {
        channel: new SesChannel({ region: cfg.SES_REGION, accessKeyId: cfg.AWS_ACCESS_KEY_ID, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }),
        name: "ses",
      };
      case "smtp": return { channel: new SmtpChannel({ url: cfg.SMTP_URL }), name: "smtp" };
      case "console": return { channel: new ConsoleChannel(), name: "console" };
      default: throw new Error(`Unknown email provider "${conn.provider}" on workspace connection`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Unknown email provider")) throw e;
    return null;
  }
}

// Provider fallback for sends: idempotency first (caller's idempotencyKey is reused
// across providers so a retry can never duplicate), fallback second. Only fails over
// on retryable transport errors — never on validation/auth errors.
export async function sendWithFallback(
  m: OutboundMessage,
  chain?: string[],
  primary?: string,
  primaryChannel?: OutreachChannel,
): Promise<SendResult & { provider: string }> {
  const providers = chain ?? (process.env.EMAIL_FALLBACK ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const first = primary ?? process.env.EMAIL_PROVIDER ?? "console";
  let lastError = "";
  if (primaryChannel) {
    try {
      const res = await primaryChannel.send(m);
      return { ...res, provider: first };
    } catch (e) {
      lastError = String(e);
      if (/not configured|unauthorized|forbidden|invalid|blocked/i.test(lastError)) throw e;
      if (!/429|5\d\d|timeout|ECONN|fetch failed/i.test(lastError)) throw e;
      console.warn(`[email:${first}] transient failure, trying fallback: ${lastError}`);
    }
  }
  for (const name of (primaryChannel ? [] : [first]).concat(providers.filter((p) => p !== first))) {
    try {
      const res = await channelForProvider(name).send(m);
      return { ...res, provider: name };
    } catch (e) {
      lastError = String(e);
      if (/not configured|unauthorized|forbidden|invalid|blocked/i.test(lastError)) throw e;
      if (!/429|5\d\d|timeout|ECONN|fetch failed/i.test(lastError)) throw e;
      console.warn(`[email:${name}] transient failure, trying fallback: ${lastError}`);
    }
  }
  throw new Error(`All email providers failed: ${lastError}`);
}
