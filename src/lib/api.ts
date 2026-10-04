import { NextResponse } from "next/server";
import { ZodError } from "zod";

// Maps thrown { status } errors (auth/validation) to proper HTTP codes.
export function withApi<T extends unknown[]>(
  fn: (...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ZodError) {
        return NextResponse.json({ error: "invalid payload", issues: e.issues }, { status: 400 });
      }
      if (e instanceof SyntaxError) {
        // Malformed JSON bodies (req.json() throws) → 400, not 500.
        return NextResponse.json({ error: "malformed JSON" }, { status: 400 });
      }
      const status = (e as { status?: number })?.status;
      if (status === 401 || status === 403) {
        return NextResponse.json({ error: (e as Error).message }, { status });
      }
      throw e;
    }
  };
}
