import { NextResponse } from "next/server";
import { safeEqual } from "./crypto";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, J } from "./db";

// Verify an Svix-style signature (Resend and other Svix senders):
// signature v1 over `${msgId}.${timestamp}.${rawBody}`, 5-minute tolerance.
export function verifySvixSignature(opts: {
  secret: string; msgId: string | null; timestamp: string | null; signatureHeader: string | null; rawBody: string;
}): boolean {
  const { secret, msgId, timestamp, signatureHeader, rawBody } = opts;
  if (!msgId || !timestamp || !signatureHeader) return false;
  const age = Math.abs(Date.now() - Number(timestamp) * 1000);
  if (!Number.isFinite(age) || age > 5 * 60_000) return false; // replay window
  const base = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(base, "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key).update(`${msgId}.${timestamp}.${rawBody}`, "utf8").digest("base64");
  for (const part of signatureHeader.split(" ")) {
    const sig = part.startsWith("v1,") ? part.slice(3) : null;
    if (!sig) continue;
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch { /* keep checking */ }
  }
  return false;
}

// Shared inbound-webhook authentication. In production the shared secret is
// mandatory: missing configuration fails closed (with an audit record) rather
// than silently accepting unsigned payloads. In non-production environments an
// unset secret preserves the existing open mode for local dev and tests.
export async function webhookAuth(req: Request, source: string): Promise<void> {
  const secret = req.headers.get("x-webhook-secret");
  const configured = process.env.EMAIL_WEBHOOK_SECRET ?? "";
  const audit = (action: string, detail: unknown) =>
    db.activityLog
      .create({ data: { actor: "system", action, detail: J({ source, ...(detail as object) }) } })
      .catch(() => undefined);
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      await audit("webhook.rejected", { reason: "secret-not-configured" });
      throw Object.assign(new Error("webhook receiver not configured"), { status: 401 });
    }
    return;
  }
  if (!safeEqual(secret, configured)) {
    await audit("webhook.rejected", { reason: "bad-signature" });
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
}

// Optional provider-specific verification (e.g. Resend via Svix). When the
// provider secret is configured AND Svix headers are present, the Svix
// signature is authoritative; otherwise falls back to the shared secret path
// above. Returns silently on success, throws 401 with audit on failure.
export async function webhookAuthSvix(req: Request, source: string, providerSecretEnv: string, rawBody: string): Promise<void> {
  const secret = process.env[providerSecretEnv] ?? "";
  const msgId = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signature = req.headers.get("svix-signature");
  if (secret && (msgId || timestamp || signature)) {
    const ok = verifySvixSignature({ secret, msgId, timestamp, signatureHeader: signature, rawBody });
    if (!ok) {
      await db.activityLog
        .create({ data: { actor: "system", action: "webhook.rejected", detail: J({ source, reason: "bad-svix-signature" }) } })
        .catch(() => undefined);
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    }
    return;
  }
  await webhookAuth(req, source);
}

export function webhookError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}
