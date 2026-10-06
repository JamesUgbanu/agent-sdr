// Integration credential verification: harmless, read-only, non-destructive
// probes that prove a configured integration actually authenticates. Never
// logs or returns credential values — only pass/fail/not_configured.
import { db } from "./db";
import { decryptSecret } from "./crypto";

export type IntegrationStatus = "pass" | "fail" | "not_configured" | "warning";
export interface IntegrationCheck {
  provider: string;
  kind: string;
  status: IntegrationStatus;
  message: string;
  checkedAt: string;
}

async function probe(url: string, headers: Record<string, string>, label: string, timeoutMs = 10000): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (r.status === 401 || r.status === 403) return { ok: false, detail: `${label}: rejected (check the credential)` };
    if (!r.ok) return { ok: false, detail: `${label}: HTTP ${r.status}` };
    return { ok: true, detail: `${label}: authenticated` };
  } catch (e) {
    return { ok: false, detail: `${label}: unreachable (${String(e).slice(0, 80)})` };
  } finally {
    clearTimeout(t);
  }
}

function connCfg(encrypted: string): Record<string, string> {
  try {
    const raw = encrypted.startsWith("{") ? encrypted : decryptSecret(encrypted);
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function workspaceConn(workspaceId: string, kind: "crm" | "calendar" | "email"): Promise<{ provider: string | null; cfg: Record<string, string> }> {
  try {
    const table = kind === "crm" ? db.crmConnection : kind === "calendar" ? db.calendarConnection : db.emailConnection;
    const c = await (table as typeof db.crmConnection).findFirst({ where: { workspaceId } });
    if (!c) return { provider: null, cfg: {} };
    return { provider: (c as { provider: string }).provider, cfg: connCfg((c as { encryptedConfig: string }).encryptedConfig) };
  } catch {
    return { provider: null, cfg: {} };
  }
}

const nc = (provider: string, kind: string, hint: string): IntegrationCheck => ({
  provider, kind, status: "not_configured", message: hint, checkedAt: new Date().toISOString(),
});
const pass = (provider: string, kind: string, message: string): IntegrationCheck => ({
  provider, kind, status: "pass", message, checkedAt: new Date().toISOString(),
});
const fail = (provider: string, kind: string, message: string): IntegrationCheck => ({
  provider, kind, status: "fail", message, checkedAt: new Date().toISOString(),
});

export async function verifyWorkspaceIntegrations(workspaceId: string): Promise<IntegrationCheck[]> {
  const results: IntegrationCheck[] = [];

  // ── Email ──
  {
    const { provider, cfg } = await workspaceConn(workspaceId, "email");
    const name = provider ?? process.env.EMAIL_PROVIDER ?? "console";
    if (name === "console") {
      results.push({ provider: "console", kind: "email", status: "warning", message: "dry-run channel — logs mail instead of sending", checkedAt: new Date().toISOString() });
    } else if (name === "resend") {
      const key = cfg.RESEND_API_KEY ?? process.env.RESEND_API_KEY ?? "";
      if (!key) results.push(nc("resend", "email", "RESEND_API_KEY missing"));
      else {
        const r = await probe("https://api.resend.com/domains", { Authorization: `Bearer ${key}` }, "Resend");
        results.push(r.ok ? pass("resend", "email", r.detail) : fail("resend", "email", r.detail));
      }
    } else if (name === "sendgrid") {
      const key = cfg.SENDGRID_API_KEY ?? process.env.SENDGRID_API_KEY ?? "";
      if (!key) results.push(nc("sendgrid", "email", "SENDGRID_API_KEY missing"));
      else {
        const r = await probe("https://api.sendgrid.com/v3/user/profile", { Authorization: `Bearer ${key}` }, "SendGrid");
        results.push(r.ok ? pass("sendgrid", "email", r.detail) : fail("sendgrid", "email", r.detail));
      }
    } else if (name === "postmark") {
      const key = cfg.POSTMARK_API_KEY ?? process.env.POSTMARK_API_KEY ?? "";
      if (!key) results.push(nc("postmark", "email", "POSTMARK_API_KEY missing"));
      else {
        const r = await probe("https://api.postmarkapp.com/server", { "X-Postmark-Server-Token": key, Accept: "application/json" }, "Postmark");
        results.push(r.ok ? pass("postmark", "email", r.detail) : fail("postmark", "email", r.detail));
      }
    } else if (name === "ses") {
      const region = cfg.SES_REGION ?? process.env.SES_REGION ?? process.env.AWS_REGION ?? "";
      if (!region) results.push(nc("ses", "email", "SES_REGION missing"));
      else {
        try {
          const { SESClient, GetSendQuotaCommand } = await import("@aws-sdk/client-ses");
          const creds = cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY
            ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }
            : undefined;
          const client = new SESClient({ region, ...(creds ? { credentials: creds } : {}) });
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 10000);
          try {
            await client.send(new GetSendQuotaCommand({}), { abortSignal: ctrl.signal });
            results.push(pass("ses", "email", "SES: credentials accepted (send quota readable)"));
          } finally {
            clearTimeout(t);
          }
          client.destroy();
        } catch (e) {
          results.push(fail("ses", "email", `SES: ${String(e).slice(0, 120)}`));
        }
      }
    } else if (name === "smtp") {
      const url = cfg.SMTP_URL ?? process.env.SMTP_URL ?? "";
      if (!url) results.push(nc("smtp", "email", "SMTP_URL missing"));
      else {
        try {
          const nodemailer = (await import("nodemailer")).default;
          const t = nodemailer.createTransport(url);
          await t.verify();
          t.close();
          results.push(pass("smtp", "email", "SMTP: connection verified (no mail sent)"));
        } catch (e) {
          results.push(fail("smtp", "email", `SMTP: ${String(e).slice(0, 120)}`));
        }
      }
    } else {
      results.push(fail(name, "email", `unknown email provider "${name}"`));
    }
  }

  // ── Prospecting / verification ──
  {
    const kind = process.env.PROSPECT_PROVIDER ?? "seed";
    if (kind === "apollo") {
      const key = process.env.APOLLO_API_KEY ?? "";
      if (!key) results.push(nc("apollo", "prospecting", "APOLLO_API_KEY missing"));
      else {
        const r = await probe("https://api.apollo.io/v1/auth/health", { "X-Api-Key": key, "Content-Type": "application/json" }, "Apollo");
        results.push(r.ok ? pass("apollo", "prospecting", r.detail) : fail("apollo", "prospecting", r.detail));
      }
    } else if (kind === "hunter") {
      const key = process.env.HUNTER_API_KEY ?? "";
      if (!key) results.push(nc("hunter", "prospecting", "HUNTER_API_KEY missing"));
      else {
        const r = await probe(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`, {}, "Hunter");
        results.push(r.ok ? pass("hunter", "prospecting", r.detail) : fail("hunter", "prospecting", r.detail));
      }
    } else if (kind === "pdl") {
      const key = process.env.PDL_API_KEY ?? "";
      results.push(key
        ? { provider: "pdl", kind: "prospecting", status: "warning", message: "key present — live ping skipped (PDL charges per call)", checkedAt: new Date().toISOString() }
        : nc("pdl", "prospecting", "PDL_API_KEY missing"));
    } else {
      results.push({ provider: "seed", kind: "prospecting", status: "warning", message: "deterministic dev seed — no real data source", checkedAt: new Date().toISOString() });
    }
    const nb = process.env.NEVERBOUNCE_API_KEY ?? "";
    if (!nb) {
      results.push(nc("neverbounce", "verification", "NEVERBOUNCE_API_KEY missing — syntax checks only"));
    } else {
      const r = await probe(`https://api.neverbounce.com/v4/account/info?key=${encodeURIComponent(nb)}`, {}, "NeverBounce");
      results.push(r.ok ? pass("neverbounce", "verification", r.detail) : fail("neverbounce", "verification", r.detail));
    }
  }

  // ── CRM ──
  {
    const { provider, cfg } = await workspaceConn(workspaceId, "crm");
    if (!provider) {
      results.push(nc("crm", "crm", "no CRM connection — connect HubSpot or Salesforce"));
    } else if (provider === "hubspot") {
      const token = cfg.token ?? process.env.HUBSPOT_TOKEN ?? "";
      if (!token) results.push(nc("hubspot", "crm", "HubSpot token missing"));
      else {
        const r = await probe("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", { Authorization: `Bearer ${token}` }, "HubSpot");
        results.push(r.ok ? pass("hubspot", "crm", r.detail) : fail("hubspot", "crm", r.detail));
      }
    } else if (provider === "salesforce") {
      const token = cfg.accessToken ?? process.env.SALESFORCE_TOKEN ?? "";
      const instance = cfg.instanceUrl ?? process.env.SALESFORCE_INSTANCE_URL ?? "";
      if (!token || !instance) results.push(nc("salesforce", "crm", "Salesforce token/instance URL missing"));
      else {
        const r = await probe(`${instance}/services/data/v59.0/limits`, { Authorization: `Bearer ${token}` }, "Salesforce");
        results.push(r.ok ? pass("salesforce", "crm", r.detail) : fail("salesforce", "crm", r.detail));
      }
    } else {
      results.push(fail(provider, "crm", `unknown CRM provider "${provider}"`));
    }
  }

  // ── Calendar ──
  {
    const { provider, cfg } = await workspaceConn(workspaceId, "calendar");
    if (!provider) {
      const g = process.env.GOOGLE_CALENDAR_TOKEN ?? "";
      const o = process.env.OUTLOOK_TOKEN ?? "";
      if (!g && !o) {
        results.push(nc("calendar", "calendar", "no calendar connection — meeting booking uses synthetic availability"));
        return results;
      }
      if (g) {
        const r = await probe("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", { Authorization: `Bearer ${g}` }, "Google Calendar");
        results.push(r.ok ? pass("google", "calendar", r.detail) : fail("google", "calendar", r.detail));
      }
      if (o) {
        const r = await probe("https://graph.microsoft.com/v1.0/me?$select=id", { Authorization: `Bearer ${o}` }, "Outlook");
        results.push(r.ok ? pass("outlook", "calendar", r.detail) : fail("outlook", "calendar", r.detail));
      }
      return results;
    }
    if (provider === "google" && cfg.accessToken) {
      const r = await probe("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", { Authorization: `Bearer ${cfg.accessToken}` }, "Google Calendar");
      results.push(r.ok ? pass("google", "calendar", r.detail) : fail("google", "calendar", r.detail));
    } else if (provider === "outlook" && cfg.accessToken) {
      const r = await probe("https://graph.microsoft.com/v1.0/me?$select=id", { Authorization: `Bearer ${cfg.accessToken}` }, "Outlook");
      results.push(r.ok ? pass("outlook", "calendar", r.detail) : fail("outlook", "calendar", r.detail));
    } else {
      results.push(nc(provider, "calendar", `${provider} connection has no access token`));
    }
  }

  return results;
}
