import { describe, it, expect } from "vitest";
import { checkConfig } from "../src/lib/config-check";

const GOOD: Record<string, string> = {
  DATABASE_URL: "postgresql://sdr:sdr@localhost:5432/sdr",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(64),
  ENCRYPTION_KEY: "b".repeat(64),
  NEXTAUTH_URL: "http://localhost:3000",
  LLM_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re-test",
  EMAIL_FROM: "SDR <sdr@example.com>",
  EMAIL_REPLY_TO: "reply@example.com",
  EMAIL_WEBHOOK_SECRET: "wh-test",
  PROSPECT_PROVIDER: "seed",
  APPROVAL_MODE_DEFAULT: "assisted",
  DAILY_SEND_LIMIT_DEFAULT: "50",
  MAX_AGENT_STEPS: "20",
  MAX_TOOL_CALLS: "30",
  MAX_RUNTIME_MS: "300000",
};

describe("config-check", () => {
  it("passes a complete dev config with no errors", () => {
    const issues = checkConfig({ ...GOOD }, false);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("flags missing DATABASE_URL as an error", () => {
    const { DATABASE_URL: _dropped, ...rest } = GOOD;
    const issues = checkConfig(rest, false);
    expect(issues.some((i) => i.key === "DATABASE_URL" && i.level === "error")).toBe(true);
  });
  it("rejects placeholder secrets", () => {
    const issues = checkConfig({ ...GOOD, AUTH_SECRET: "change-me-in-production-min-32-chars" }, false);
    expect(issues.some((i) => i.key === "AUTH_SECRET")).toBe(true);
  });
  it("rejects unknown providers and modes", () => {
    const issues = checkConfig({ ...GOOD, LLM_PROVIDER: "telepathy", APPROVAL_MODE_DEFAULT: "yolo" as string }, false);
    expect(issues.some((i) => i.key === "LLM_PROVIDER" && i.level === "error")).toBe(true);
    expect(issues.some((i) => i.key === "APPROVAL_MODE_DEFAULT" && i.level === "error")).toBe(true);
  });
  it("requires webhook secret in strict mode, warns otherwise", () => {
    const { EMAIL_WEBHOOK_SECRET: _w, ...rest } = GOOD;
    expect(checkConfig(rest, true).some((i) => i.key === "EMAIL_WEBHOOK_SECRET" && i.level === "error")).toBe(true);
    expect(checkConfig(rest, false).some((i) => i.key === "EMAIL_WEBHOOK_SECRET" && i.level === "warning")).toBe(true);
  });
  it("requires matching email credentials in strict mode", () => {
    const { RESEND_API_KEY: _k, ...rest } = GOOD;
    expect(checkConfig(rest, true).some((i) => i.key === "RESEND_API_KEY" && i.level === "error")).toBe(true);
  });
  it("requires an LLM key", () => {
    const rest = { ...GOOD };
    delete rest.OPENAI_API_KEY;
    expect(checkConfig(rest, false).some((i) => i.level === "error")).toBe(true);
  });
  it("never includes secret values in messages", () => {
    const issues = checkConfig({ ...GOOD, OPENAI_API_KEY: "sk-super-secret-value" }, false);
    expect(JSON.stringify(issues)).not.toContain("sk-super-secret-value");
  });
});
