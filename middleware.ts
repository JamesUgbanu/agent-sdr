import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { rateLimit } from "./src/lib/rate-limit";

// Edge middleware: rate limiting only. Authentication is session-based (Auth.js)
// and enforced per-route via requireSession/requireMembership; webhooks use their
// own secrets. No header-based auth remains.
export function middleware(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!rateLimit(`api:${ip}`, 120, 60_000)) {
    return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  }
  return NextResponse.next();
}
export const config = { matcher: ["/api/:path*"] };
