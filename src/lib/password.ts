import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { db } from "./db";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [algo, salt, hash] = stored.split(":");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const derived = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Pure revocation predicate: a session is revoked when its user no longer
// exists, or when the stamped version differs from the current one.
// A missing stamp means a legacy pre-versioning token, which callers adopt.
export function isSessionRevoked(tokenSv: number | undefined, userSv: number | null | undefined): boolean {
  if (userSv == null) return true;
  if (tokenSv == null) return false;
  return tokenSv !== userSv;
}

// Change password AND revoke all other sessions by bumping sessionVersion.
export async function changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
  if (newPassword.length < 10) throw new Error("new password must be at least 10 characters");
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.passwordHash || !verifyPassword(oldPassword, user.passwordHash)) {
    throw new Error("current password is incorrect");
  }
  await db.user.update({
    where: { id: userId },
    data: { passwordHash: hashPassword(newPassword), sessionVersion: { increment: 1 } },
  });
}
