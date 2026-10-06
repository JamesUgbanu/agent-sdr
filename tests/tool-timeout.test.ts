import { describe, it, expect, vi, afterEach } from "vitest";
import { withToolTimeout, ToolTimeoutError, toolTimeoutMs } from "../src/lib/tool-timeout";

describe("tool timeouts", () => {
  afterEach(() => {
    delete process.env.TOOL_TIMEOUT_MS;
    vi.unstubAllEnvs?.();
  });
  it("resolves fast tools untouched", async () => {
    await expect(withToolTimeout("t", async () => 42, 1000)).resolves.toBe(42);
  });
  it("rejects hung tools with a named timeout error", async () => {
    const err = await withToolTimeout("hang", () => new Promise(() => undefined), 20).catch((e) => e);
    expect(err).toBeInstanceOf(ToolTimeoutError);
    expect((err as Error).message).toMatch(/hang.*20ms/);
    expect(String(err)).toMatch(/timeout/i); // matches the retry classifier
  });
  it("reads TOOL_TIMEOUT_MS with a safe default", () => {
    delete process.env.TOOL_TIMEOUT_MS;
    expect(toolTimeoutMs()).toBe(120000);
    process.env.TOOL_TIMEOUT_MS = "5000";
    expect(toolTimeoutMs()).toBe(5000);
    process.env.TOOL_TIMEOUT_MS = "garbage";
    expect(toolTimeoutMs()).toBe(120000);
  });
});
