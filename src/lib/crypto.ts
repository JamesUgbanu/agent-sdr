import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "crypto";

// AES-256-GCM for OAuth tokens / provider configs at rest. Key from env, never committed.
function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY ?? process.env.AUTH_SECRET ?? "";
  if (secret.length < 32) throw new Error("ENCRYPTION_KEY (≥32 chars) required for secret encryption");
  return scryptSync(secret, "sdr-salt", 32);
}
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}
export function decryptSecret(payload: string): string {
  const [iv, tag, data] = payload.split(":");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv!, "hex"));
  d.setAuthTag(Buffer.from(tag!, "hex"));
  return d.update(Buffer.from(data!, "hex")) + d.final("utf8");
}

// Constant-time string comparison for webhook/shared secrets.
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
