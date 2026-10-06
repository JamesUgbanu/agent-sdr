// Production configuration validation. Pure function over env — safe to run
// at deploy time, in CI, and at application boot. Never logs secret values,
// only key names and human-readable guidance.
export interface ConfigIssue {
  key: string;
  level: "error" | "warning";
  message: string;
}

type Env = Record<string, string | undefined>;

const LLM_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"] as const;
const EMAIL_PROVIDERS = ["resend", "sendgrid", "postmark", "ses", "smtp", "console"] as const;
const EMAIL_CREDS: Record<string, string[]> = {
  resend: ["RESEND_API_KEY"],
  sendgrid: ["SENDGRID_API_KEY"],
  postmark: ["POSTMARK_API_KEY"],
  ses: ["SES_REGION"],
  smtp: ["SMTP_URL"],
  console: [],
};

export function checkConfig(env: Env = process.env, strict = false): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const err = (key: string, message: string) => issues.push({ key, level: "error", message });
  const warn = (key: string, message: string) => issues.push({ key, level: "warning", message });
  const present = (k: string) => (env[k] ?? "").length > 0;

  if (!present("DATABASE_URL")) err("DATABASE_URL", "missing — the app cannot start without Postgres");
  else if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL!)) err("DATABASE_URL", "must be a postgresql:// URL");

  if (!present("REDIS_URL")) {
    strict ? err("REDIS_URL", "missing — workers fall back to in-process dispatch, which loses jobs on restart") : warn("REDIS_URL", "missing — job dispatch falls back to in-process (fine for local dev only)");
  }

  for (const k of ["AUTH_SECRET", "ENCRYPTION_KEY"] as const) {
    const v = env[k] ?? "";
    if (!v || v.includes("change-me") || v.length < 32) {
      const msg = `${k} must be a generated secret of at least 32 characters`;
      strict ? err(k, msg) : warn(k, `${msg} (dev placeholders are replaced with ephemeral values inside Docker)`);
    }
  }

  const appUrl = env.NEXTAUTH_URL ?? "";
  try {
    const u = new URL(appUrl);
    if (strict && u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) {
      err("NEXTAUTH_URL", "must use https in production (plain http leaks session cookies)");
    }
  } catch {
    err("NEXTAUTH_URL", "missing or not a valid URL — Auth.js callbacks depend on it");
  }

  const llmProvider = env.LLM_PROVIDER ?? "openai";
  if (!["openai", "anthropic", "deepseek", "openrouter"].includes(llmProvider)) {
    err("LLM_PROVIDER", `unknown provider "${llmProvider}" — use openai|anthropic|deepseek|openrouter`);
  }
  if (!LLM_KEYS.some(present)) {
    err("OPENAI_API_KEY", "no LLM provider key configured — set at least one of OPENAI/ANTHROPIC/DEEPSEEK/OPENROUTER_API_KEY");
  }

  const emailProvider = env.EMAIL_PROVIDER ?? "console";
  if (!(EMAIL_PROVIDERS as readonly string[]).includes(emailProvider)) {
    err("EMAIL_PROVIDER", `unknown provider "${emailProvider}"`);
  } else if (emailProvider === "console" && strict) {
    warn("EMAIL_PROVIDER", "console is a dry-run that logs instead of sending — pick a real provider for production");
  } else {
    for (const k of EMAIL_CREDS[emailProvider] ?? []) {
      if (!present(k)) {
        const msg = `${k} is required by EMAIL_PROVIDER=${emailProvider}`;
        strict ? err(k, msg) : warn(k, msg);
      }
    }
  }
  const from = env.EMAIL_FROM ?? "";
  if (!from.includes("@")) {
    strict ? err("EMAIL_FROM", "must be a valid sender address") : warn("EMAIL_FROM", "sender address looks unset — outbound mail will use a placeholder");
  }
  if (!present("EMAIL_WEBHOOK_SECRET")) {
    strict
      ? err("EMAIL_WEBHOOK_SECRET", "required in production — without it anyone can inject replies/bounces")
      : warn("EMAIL_WEBHOOK_SECRET", "unset — inbound webhooks accept unsigned payloads (local dev only)");
  }

  const prospect = env.PROSPECT_PROVIDER ?? "seed";
  if (!["seed", "apollo", "hunter", "pdl"].includes(prospect)) err("PROSPECT_PROVIDER", `unknown provider "${prospect}"`);
  const approval = env.APPROVAL_MODE_DEFAULT ?? "assisted";
  if (!["manual", "assisted", "autonomous"].includes(approval)) err("APPROVAL_MODE_DEFAULT", `unknown mode "${approval}"`);
  const daily = Number(env.DAILY_SEND_LIMIT_DEFAULT ?? "50");
  if (!Number.isInteger(daily) || daily < 1) err("DAILY_SEND_LIMIT_DEFAULT", "must be a positive integer");
  for (const k of ["MAX_AGENT_STEPS", "MAX_TOOL_CALLS", "MAX_RUNTIME_MS"] as const) {
    const n = Number(env[k] ?? "1");
    if (!Number.isFinite(n) || n < 1) err(k, "must be a positive number");
  }
  return issues;
}
