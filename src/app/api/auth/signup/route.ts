import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { withApi } from "@/lib/api";

// Self-serve signup: creates user + personal workspace + membership.
// Disable in production with SIGNUP_ENABLED=false.
async function postHandler(req: Request) {
  if (process.env.SIGNUP_ENABLED === "false") {
    return NextResponse.json({ error: "signup disabled" }, { status: 403 });
  }
  const { email, password, name } = z.object({
    email: z.string().email(), password: z.string().min(10), name: z.string().optional(),
  }).parse(await req.json());
  const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return NextResponse.json({ error: "email taken" }, { status: 409 });
  // Single transaction: a failure partway must not leave an orphan user.
  try {
    const created = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: email.toLowerCase(), name, passwordHash: hashPassword(password) },
      });
      const ws = await tx.workspace.create({ data: { name: `${name ?? email}'s workspace` } });
      await tx.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: "owner" } });
      return { user, ws };
    });
    return NextResponse.json({ ok: true, userId: created.user.id, workspaceId: created.ws.id }, { status: 201 });
  } catch (e) {
    // Registration race (two signups, same email): unique violation → 409, not 500.
    if (String(e).includes("Unique constraint") || (e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "email taken" }, { status: 409 });
    }
    throw e;
  }
}

export const POST = withApi(postHandler);
