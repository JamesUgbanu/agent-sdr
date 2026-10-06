// Shared execution boundary for tool invocations: every external tool call
// gets a configurable timeout so one hung provider can never consume an
// entire agent run. Timeouts surface as errors containing "timeout", which the
// existing retry classifier treats as retryable; tools with their own
// reconciliation (e.g. sendEmail's idempotency claim) stay safe on retry.
export class ToolTimeoutError extends Error {
  toolName: string;
  timeoutMs: number;
  constructor(toolName: string, timeoutMs: number) {
    // NOTE: message must contain "timeout" — the queue retry classifier matches on it.
    super(`tool timeout: ${toolName} exceeded ${timeoutMs}ms`);
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

export function toolTimeoutMs(): number {
  const n = Number(process.env.TOOL_TIMEOUT_MS ?? "120000");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120000;
}

export async function withToolTimeout<T>(toolName: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const ms = timeoutMs ?? toolTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(toolName, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
