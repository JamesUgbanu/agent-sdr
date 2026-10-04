import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { db } from "@/lib/db";

// Liveness + readiness for Compose healthchecks and orchestrators.
// Reports DB reachability; never exposes internals beyond a boolean.
export async function GET() {
  let database = false;
  try {
    await db.$queryRaw`SELECT 1`;
    database = true;
  } catch {
    database = false;
  }
  return NextResponse.json({ ok: true, database }, { status: database ? 200 : 503 });
}
