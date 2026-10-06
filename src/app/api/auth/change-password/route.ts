import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { withApi } from "@/lib/api";

// POST /api/auth/change-password { oldPassword, newPassword } — verifies the
// current password, sets the new hash, and revokes all other sessions.
async function postHandler(req: Request) {
  const { oldPassword, newPassword } = z.object({
    oldPassword: z.string().min(1), newPassword: z.string().min(10),
  }).parse(await req.json());
  const { requireSession } = await import("@/lib/session");
  const { userId } = await requireSession();
  const { changePassword } = await import("@/lib/password");
  await changePassword(userId, oldPassword, newPassword);
  return NextResponse.json({ ok: true });
}

export const POST = withApi(postHandler);
