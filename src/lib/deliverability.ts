// Deliverability preflight: checks what can realistically be checked
// programmatically before a client enables autonomous sending. It never claims
// to guarantee inbox placement — only that the plumbing is correct.
// Statuses: pass | warning | fail. Verdict FAIL blocks autonomous sending.
import { promises as dns } from "node:dns";
import { db, J } from "./db";

export type CheckStatus = "pass" | "warning" | "fail";
export interface DeliverabilityCheckItem {
  id: string;
  category: "domain" | "app" | "operational";
  label: string;
  status: CheckStatus;
  detail: string;
}
export type PreflightVerdict = "PASS" | "WARNING" | "FAIL";

export interface DnsResolver {
  lookup(host: string): Promise<unknown>;
  resolveTxt(host: string): Promise<string[][]>;
}

const realDns: DnsResolver = {
  lookup: (host) => import("node:dns").then((m) => m.promises.lookup(host)),
  resolveTxt: (host) => import("node:dns").then((m) => m.promises.resolveTxt(host)),
};

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DKIM_SELECTORS = ["google", "selector1", "selector2", "s1", "s2", "default", "mandrill", "k1", "everlytickey1", "mxvault"];

export function extractSendingDomain(from: string): string | null {
  const m = from.match(/<([^>]+)>/)?.[1] ?? from;
  const domain = m.trim().split("@")[1]?.toLowerCase();
  return domain && domain.includes(".") ? domain : null;
}

export async function runDeliverabilityPreflight(opts: {
  workspaceId: string;
  domain?: string;
  from?: string;
  dns?: DnsResolver;
  timeoutMs?: number;
}): Promise<{ checks: DeliverabilityCheckItem[]; verdict: PreflightVerdict; autonomousBlocked: boolean; checkedAt: string }> {
  const resolver = opts.dns ?? realDns;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const checks: DeliverabilityCheckItem[] = [];
  const push = (c: DeliverabilityCheckItem) => checks.push(c);

  const from = opts.from ?? process.env.EMAIL_FROM ?? "";
  const domain = opts.domain ?? extractSendingDomain(from);

  // ── Domain ──
  if (!domain) {
    push({ id: "domain.parse", category: "domain", label: "Sending domain", status: "fail", detail: "could not derive a domain from EMAIL_FROM — set a real sender address" });
  } else {
    try {
      await withTimeout(resolver.lookup(domain), timeoutMs, "DNS lookup");
      push({ id: "domain.dns", category: "domain", label: "DNS resolution", status: "pass", detail: `${domain} resolves` });
    } catch (e) {
      push({ id: "domain.dns", category: "domain", label: "DNS resolution", status: "fail", detail: `${domain} does not resolve: ${String(e).slice(0, 120)}` });
    }
    try {
      const txt = await withTimeout(resolver.resolveTxt(domain), timeoutMs, "SPF lookup");
      const spf = txt.flat().find((r) => r.startsWith("v=spf1"));
      if (spf) push({ id: "domain.spf", category: "domain", label: "SPF", status: "pass", detail: spf.slice(0, 160) });
      else push({ id: "domain.spf", category: "domain", label: "SPF", status: "fail", detail: "no v=spf1 record — receiving servers will distrust this domain" });
    } catch {
      push({ id: "domain.spf", category: "domain", label: "SPF", status: "fail", detail: "no TXT records readable for domain" });
    }
    try {
      const txt = await withTimeout(resolver.resolveTxt(`_dmarc.${domain}`), timeoutMs, "DMARC lookup");
      const dmarc = txt.flat().find((r) => r.includes("DMARC1"));
      if (dmarc) push({ id: "domain.dmarc", category: "domain", label: "DMARC", status: "pass", detail: dmarc.slice(0, 160) });
      else push({ id: "domain.dmarc", category: "domain", label: "DMARC", status: "warning", detail: "no DMARC policy — spoofing protection missing (does not block sending)" });
    } catch {
      push({ id: "domain.dmarc", category: "domain", label: "DMARC", status: "warning", detail: "no _dmarc record found" });
    }
    let dkimFound: string | null = null;
    for (const sel of DKIM_SELECTORS) {
      try {
        const txt = await withTimeout(resolver.resolveTxt(`${sel}._domainkey.${domain}`), timeoutMs, `DKIM ${sel}`);
        if (txt.flat().some((r) => r.includes("v=DKIM1"))) { dkimFound = sel; break; }
      } catch { /* try next selector */ }
    }
    if (dkimFound) {
      push({ id: "domain.dkim", category: "domain", label: "DKIM", status: "pass", detail: `signing key found (selector ${dkimFound})` });
    } else {
      push({ id: "domain.dkim", category: "domain", label: "DKIM", status: "warning", detail: "no key found under common selectors — verify the signing selector in your email provider dashboard" });
    }
  }

  // ── Application ──
  const provider = process.env.EMAIL_PROVIDER ?? "console";
  if (provider === "console") {
    push({ id: "app.provider", category: "app", label: "Email provider", status: "fail", detail: "console provider only logs mail — autonomous sending impossible" });
  } else {
    const { channelForProvider } = await import("./email");
    try {
      channelForProvider(provider); // throws on unknown names
      push({ id: "app.provider", category: "app", label: "Email provider", status: "pass", detail: `provider adapter '${provider}' available` });
    } catch (e) {
      push({ id: "app.provider", category: "app", label: "Email provider", status: "fail", detail: String(e).slice(0, 160) });
    }
  }
  push(from.includes("@")
    ? { id: "app.from", category: "app", label: "From address", status: "pass", detail: `sender: ${from.slice(0, 80)}` }
    : { id: "app.from", category: "app", label: "From address", status: "fail", detail: "EMAIL_FROM is missing or invalid" });
  if (process.env.EMAIL_REPLY_TO) {
    push({ id: "app.replyto", category: "app", label: "Reply-to", status: "pass", detail: "reply-to configured" });
  } else {
    push({ id: "app.replyto", category: "app", label: "Reply-to", status: "warning", detail: "no reply-to — replies may go nowhere" });
  }
  push(process.env.EMAIL_WEBHOOK_SECRET
    ? { id: "app.webhook", category: "app", label: "Webhook secret", status: "pass", detail: "inbound webhook receivers are authenticated" }
    : { id: "app.webhook", category: "app", label: "Webhook secret", status: "fail", detail: "EMAIL_WEBHOOK_SECRET unset — anyone can inject replies/bounces" });
  try {
    await db.suppression.findFirst({ where: { workspaceId: opts.workspaceId } });
    push({ id: "app.suppression", category: "app", label: "Suppression system", status: "pass", detail: "suppression store reachable" });
  } catch {
    push({ id: "app.suppression", category: "app", label: "Suppression system", status: "fail", detail: "suppression store unreachable" });
  }
  const daily = Number(process.env.DAILY_SEND_LIMIT_DEFAULT ?? "50");
  push(Number.isInteger(daily) && daily > 0
    ? { id: "app.limits", category: "app", label: "Sending limits", status: "pass", detail: `daily cap: ${daily}` }
    : { id: "app.limits", category: "app", label: "Sending limits", status: "fail", detail: "DAILY_SEND_LIMIT_DEFAULT must be a positive integer" });

  // ── Operational ──
  try {
    const campaigns = await db.campaign.findMany({ where: { workspaceId: opts.workspaceId, status: "active" }, select: { id: true, timezone: true, approvalPolicy: true } });
    push(campaigns.length > 0
      ? { id: "ops.campaigns", category: "operational", label: "Active campaigns", status: "pass", detail: `${campaigns.length} active` }
      : { id: "ops.campaigns", category: "operational", label: "Active campaigns", status: "warning", detail: "no active campaigns yet" });
    const badTz = campaigns.filter((c) => { try { Intl.DateTimeFormat(undefined, { timeZone: c.timezone }); return false; } catch { return true; } });
    push(badTz.length === 0
      ? { id: "ops.timezone", category: "operational", label: "Timezone", status: "pass", detail: "campaign timezones valid" }
      : { id: "ops.timezone", category: "operational", label: "Timezone", status: "warning", detail: `${badTz.length} campaign(s) with invalid timezone` });
    const bounced = await db.message.count({ where: { thread: { lead: { workspaceId: opts.workspaceId } }, status: "bounced" } });
    const sent = await db.message.count({ where: { thread: { lead: { workspaceId: opts.workspaceId } }, status: { in: ["sent", "delivered"] } } });
    const bounceRate = sent > 0 ? bounced / sent : 0;
    push(bounceRate < 0.05
      ? { id: "ops.bounce", category: "operational", label: "Bounce rate", status: "pass", detail: `${(bounceRate * 100).toFixed(1)}% (${bounced}/${sent})` }
      : { id: "ops.bounce", category: "operational", label: "Bounce rate", status: "fail", detail: `${(bounceRate * 100).toFixed(1)}% exceeds 5% — stop and clean the list` });
  } catch {
    push({ id: "ops.campaigns", category: "operational", label: "Operational state", status: "fail", detail: "could not read campaign state" });
  }

  const verdict: PreflightVerdict = checks.some((c) => c.status === "fail") ? "FAIL" : checks.some((c) => c.status === "warning") ? "WARNING" : "PASS";
  const checkedAt = new Date().toISOString();
  try {
    await db.deliverabilityCheck.create({ data: { workspaceId: opts.workspaceId, verdict, checks: J(checks) } });
  } catch { /* preflight must never break the caller */ }
  return { checks, verdict, autonomousBlocked: verdict === "FAIL", checkedAt };
}

export async function latestPreflightVerdict(workspaceId: string, maxAgeMs = 30 * 86400_000): Promise<PreflightVerdict | null> {
  try {
    const row = await db.deliverabilityCheck.findFirst({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
    if (!row) return null;
    if (Date.now() - row.createdAt.getTime() > maxAgeMs) return null;
    return row.verdict as PreflightVerdict;
  } catch {
    return null;
  }
}

export interface OperationalAlert {
  kind: "bounce_spike" | "complaint" | "provider_failures";
  message: string;
}

// Operational alerting at ingest/send time (not just dashboard display).
// Creates a deduplicated open ops_alert task so the operator is notified
// inside the normal approval/review workflow. Never throws.
export async function evaluateOperationalAlerts(opts: {
  workspaceId: string;
  leadId?: string;
  trigger: "bounce" | "complaint" | "send_failure";
}): Promise<OperationalAlert[]> {
  const raised: OperationalAlert[] = [];
  try {
    const since = new Date(Date.now() - 86400_000);
    const scope = { thread: { lead: { workspaceId: opts.workspaceId } } };
    const [bounces, complaints, sent, failed] = await Promise.all([
      db.message.count({ where: { status: "bounced", sentAt: { gte: since }, ...scope } }),
      db.messageEvent.count({ where: { type: { endsWith: ".complained" }, createdAt: { gte: since }, message: { thread: { lead: { workspaceId: opts.workspaceId } } } } }),
      db.message.count({ where: { status: { in: ["sent", "delivered"] }, sentAt: { gte: since }, ...scope } }),
      db.message.count({ where: { status: "failed", createdAt: { gte: since }, ...scope } }),
    ]);
    const candidates: Array<{ kind: OperationalAlert["kind"]; message: string; fire: boolean }> = [
      {
        kind: "bounce_spike",
        message: `bounce rate ${(sent > 0 ? (bounces / sent) * 100 : 0).toFixed(1)}% over 24h (${bounces}/${sent} sent) — pause sending and clean the list`,
        fire: sent >= 10 && bounces / sent >= 0.05,
      },
      {
        kind: "complaint",
        message: `${complaints} spam complaint(s) in 24h — review messaging and targeting immediately`,
        fire: complaints >= 1,
      },
      {
        kind: "provider_failures",
        message: `${failed} failed send(s) in 24h — check provider credentials and dead letters`,
        fire: failed >= 5,
      },
    ];
    for (const c of candidates) {
      if (!c.fire) continue;
      const dup = await db.agentTask.findFirst({
        where: {
          lead: { workspaceId: opts.workspaceId },
          type: "ops_alert",
          status: "open",
          createdAt: { gte: since },
        },
      }).catch(() => null);
      // Payload carries the kind; one open alert per kind per day is enough.
      const sameKind = dup && (dup.payload as { kind?: string } | null)?.kind === c.kind;
      if (sameKind) continue;
      raised.push({ kind: c.kind, message: c.message });
      if (opts.leadId) {
        await db.agentTask.create({
          data: { leadId: opts.leadId, type: "ops_alert", status: "open", payload: J({ kind: c.kind, message: c.message }) },
        }).catch(() => undefined);
      }
      await db.agentEvent.create({
        data: { leadId: opts.leadId, kind: "ops.alert", message: c.message, payload: J({ kind: c.kind }) },
      }).catch(() => undefined);
    }
  } catch { /* alerting must never break sending/webhooks */ }
  return raised;
}
