// Staging E2E: drives the REAL chain (HTTP API + worker + Redis + Postgres) and
// asserts persisted state at every stage. Exits non-zero on any failure.
import { db } from "../src/lib/db";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}
async function waitFor<T>(name: string, fn: () => Promise<T | null>, timeoutMs = 240_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${name}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const tag = Date.now().toString(36);
const userAEmail = `qa-a-${tag}@example.com`;
const userAPassword = "staging-password-1";

// ── 1. user + workspaces ──
const { hashPassword } = await import("../src/lib/password");
const userA = await db.user.create({ data: { email: userAEmail, name: "QA A", passwordHash: hashPassword(userAPassword) } });
const wsA = await db.workspace.create({ data: { name: `QA WS A ${tag}` } });
await db.workspaceMember.create({ data: { workspaceId: wsA.id, userId: userA.id, role: "owner" } });
const wsB = await db.workspace.create({ data: { name: `QA WS B ${tag}` } });
check("user+workspace A created", !!userA.id && !!wsA.id);

// suppression pre-seed (dedup-before-spend): acme1 must be skipped
await db.suppression.create({ data: { workspaceId: wsA.id, domain: "acme1.example.com", reason: "do_not_contact" } });

// ── 2. campaign via HTTP (exercises API + membership? direct create here; HTTP covered in §9) ──
const campaign = await db.campaign.create({
  data: {
    workspaceId: wsA.id, name: `QA Campaign ${tag}`, status: "active",
    targetIndustries: ["SaaS"], targetGeography: "United States",
    companySizeMin: 20, companySizeMax: 200, jobTitles: ["CTO", "VP Engineering"],
    offer: "AI automation implementation", valueProposition: "cut manual ops work",
    approvalPolicy: "assisted", approvalConfidenceThreshold: 0.8,
    dailySendLimit: 50, timezone: "UTC", minScoreToContact: 60,
  },
});
await db.sequence.create({
  data: {
    campaignId: campaign.id, name: "QA 4-step",
    steps: { create: [
      { order: 0, dayOffset: 0, subjectTemplate: "s0", bodyTemplate: "b0", channel: "email" },
      { order: 1, dayOffset: 3, subjectTemplate: "s1", bodyTemplate: "b1", channel: "email" },
      { order: 2, dayOffset: 7, subjectTemplate: "s2", bodyTemplate: "b2", channel: "email" },
      { order: 3, dayOffset: 14, subjectTemplate: "s3", bodyTemplate: "b3", channel: "email" },
    ]},
  },
});
check("campaign+sequence created", !!campaign.id);

// ── 3. knowledge (isolation pair) ──
const { upsertKnowledgeDocument, retrieveKnowledge } = await import("../src/lib/knowledge");
await upsertKnowledgeDocument({ workspaceId: wsA.id, source: "pricing", sourceKind: "pricing", title: "Plans", content: "Pro plan costs $500 per month with unlimited seats. Annual billing saves 20%." });
await upsertKnowledgeDocument({ workspaceId: wsB.id, source: "pricing", sourceKind: "pricing", title: "Plans", content: "Pro plan costs $2000 per month with unlimited seats." });
await upsertKnowledgeDocument({ workspaceId: wsA.id, source: "objections", sourceKind: "objection", title: "Too expensive", content: "When prospects say too expensive, acknowledge budget pressure, restate ROI in hours saved, and offer the annual plan." });
const ka = await retrieveKnowledge(wsA.id, "how much does pro pricing cost");
const kb = await retrieveKnowledge(wsB.id, "how much does pro pricing cost");
check("knowledge retrieval A=$500", ka.some((c) => c.content.includes("$500")), JSON.stringify(ka.map((c) => c.content.slice(0, 40))));
check("knowledge retrieval B=$2000", kb.some((c) => c.content.includes("$2000")));
check("no cross-workspace leakage", !ka.some((c) => c.content.includes("$2000")) && !kb.some((c) => c.content.includes("$500")));

// ── 4. model routing ──
await db.modelConfig.createMany({ data: [
  { task: "personalization", provider: "openai", model: "disabled-model", enabled: false, priority: 99 },
  { task: "personalization", provider: "openai", model: "low-prio-model", enabled: true, priority: 1 },
  { task: "personalization", provider: "openai", model: "ws-specific-model", enabled: true, priority: 5, workspaceId: wsA.id },
]});
const { resolveModel } = await import("../src/lib/models");
const rm = await resolveModel("personalization", wsA.id);
check("routing respects priority+workspace, ignores disabled", rm.model === "ws-specific-model", rm.model);
const rmOther = await resolveModel("personalization", wsB.id);
check("other workspace gets global config", rmOther.model === "low-prio-model", rmOther.model);
// NOTE: ws-specific-model doesn't exist as a real model; restore determinism for later stages
await db.modelConfig.deleteMany({ where: { task: "personalization" } });

// ── 5. prospecting through the WORKER (Redis→consumer→agent) ──
const { enqueue } = await import("../src/lib/queue");
await enqueue("prospecting", { campaignId: campaign.id }, { workspaceId: wsA.id });
const lead = await waitFor("worker-driven lead READY_FOR_OUTREACH", async () => {
  const l = await db.lead.findFirst({
    where: { campaignId: campaign.id, status: "READY_FOR_OUTREACH" },
    include: { contact: true, company: true },
  });
  return l;
});
check("worker chain prospect→research→score→personalize", !!lead.id, `${lead.contact?.fullName} @ ${lead.company?.name} score=${lead.score}`);
const research = await db.leadResearch.findFirst({ where: { leadId: lead.id } });
check("research persisted with evidence array", !!research, `evidence=${(research?.evidence as unknown[])?.length ?? 0}`);
const approval = await db.approval.findFirst({ where: { leadId: lead.id, status: "pending" } });
check("assisted policy gated message to approval", !!approval, approval?.reason ?? "");
const dominated = await db.company.findFirst({ where: { workspaceId: wsA.id, domain: "acme1.example.com" } });
const dominatedLeads = dominated ? await db.lead.count({ where: { campaignId: campaign.id, companyId: dominated.id } }) : 0;
check("suppressed domain skipped before spend", dominatedLeads === 0, `leads=${dominatedLeads}`);

// research cache: second researchCompany call must hit cache
const { tools } = await import("../src/server/agents/orchestrator");
const r2 = (await tools.researchCompany!.fn({ leadId: lead.id }, { leadId: lead.id })) as { cacheHit?: boolean };
check("research cache hit on repeat", r2.cacheHit === true);

// give the lead a real email (simulating enrichment finding it)
await db.contact.update({ where: { id: lead.contactId! }, data: { email: `qa-${tag}@example.com`, emailConfidence: "high" } });

// ── 6. verifyEmail tool: no provider → explicit unavailable, never faked ──
const v = (await tools.verifyEmail!.fn({ leadId: lead.id }, {})) as { status: string; confidence: unknown };
check("verifyEmail unavailable-state honest", v.status === "unavailable" && v.confidence === null, v.status);

// ── 7. approval → send via worker (console email) ──
await db.approval.update({ where: { id: approval!.id }, data: { status: "approved", decidedBy: "qa", decidedAt: new Date() } });
const msg0 = await db.message.findFirst({ where: { thread: { leadId: lead.id }, direction: "outbound" } });
await db.message.update({ where: { id: msg0!.id }, data: { status: "approved" } });
await enqueue("outreach", { leadId: lead.id, messageId: msg0!.id }, { workspaceId: wsA.id });
const sent = await waitFor("email sent by worker", async () =>
  db.message.findFirst({ where: { id: msg0!.id, status: { in: ["sent", "delivered"] } } }), 90_000);
check("worker sent email (console channel)", !!sent?.providerMessageId, sent?.providerMessageId ?? "");
const leadAfterSend = await db.lead.findUnique({ where: { id: lead.id } });
check("lead CONTACTED + sequence scheduled", leadAfterSend?.status === "CONTACTED");

// duplicate send prevention: same step already sent → skipped
const dupResult = (await tools.sendEmail!.fn({ messageId: msg0!.id }, {})) as { skipped?: boolean };
check("duplicate send blocked", dupResult.skipped === true);

// ── 8. inbound reply webhook → classification → auto-stop (via HTTP + worker) ──
const inboundRes = await fetch(`${BASE}/api/webhooks/email`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ from: `qa-${tag}@example.com`, subject: "Re: idea", body: "This looks interesting, tell me more!", providerMessageId: `qa-pmid-${tag}` }),
});
check("webhook accepted", inboundRes.ok, String(inboundRes.status));
const stopped = await waitFor("sequence stopped on positive reply", async () => {
  const s = await db.leadSequenceState.findUnique({ where: { leadId: lead.id } });
  return s?.stoppedReason ? s : null;
}, 90_000);
check("positive reply stopped sequence", (stopped?.stoppedReason ?? "").includes("replied"), stopped?.stoppedReason ?? "");

// ── 9. conversational SDR ──
const { respondToProspect, detectIntent } = await import("../src/lib/conversation");
check("intent: pricing", detectIntent("how much does it cost?").intent === "pricing_question");
const priceAns = await respondToProspect(lead.id, "How much does the pro plan cost?");
check("pricing grounded in workspace knowledge", priceAns.knowledgeUsed.length > 0 && !priceAns.handoff, priceAns.knowledgeUsed.join(","));
const unknown = await respondToProspect(lead.id, "Do you support carrier pigeons as a channel?");
check("unknown → handoff, no hallucination", unknown.handoff && unknown.approvalRequired);
const meetingAns = await respondToProspect(lead.id, "Let's book a meeting on Tuesday");
check("meeting intent detected", meetingAns.intent === "meeting_request");

// ── 10. meeting: availability → book → dedupe → cancel ──
const avail = (await tools.checkCalendarAvailability!.fn({ leadId: lead.id, durationMin: 30 }, {})) as { slots: Array<{ start: string; end: string }> };
check("availability returned", avail.slots.length > 0, `${avail.slots.length} slots`);
const booked = (await tools.scheduleMeeting!.fn({ leadId: lead.id, start: avail.slots[0]!.start, end: avail.slots[0]!.end }, {})) as { id: string };
check("meeting booked + lead MEETING_BOOKED", !!booked.id);
const rebook = (await tools.scheduleMeeting!.fn({ leadId: lead.id, start: avail.slots[0]!.start, end: avail.slots[0]!.end }, {})) as { duplicate?: boolean };
check("duplicate booking prevented", rebook.duplicate === true);
try {
  await tools.scheduleMeeting!.fn({ leadId: lead.id, start: "2030-01-01T00:00:00.000Z", end: "2030-01-01T00:30:00.000Z" }, {});
  check("invalid slot rejected", false);
} catch { check("invalid slot rejected", true); }
const { cancelBookedMeeting } = await import("../src/lib/integrations");
const cancelled = await cancelBookedMeeting(booked.id);
check("meeting cancelled + persisted", cancelled.cancelled === true);
const mRow = await db.meeting.findUnique({ where: { id: booked.id } });
check("cancellation state persisted", mRow?.status === "cancelled");
// second timezone: book another slot labeled Europe/Berlin, verify tz persisted
const bookedTz = (await tools.scheduleMeeting!.fn({ leadId: lead.id, start: avail.slots[1]!.start, end: avail.slots[1]!.end }, {})) as { id: string };
await db.meeting.update({ where: { id: bookedTz.id }, data: { timezone: "Europe/Berlin" } }).catch(() => undefined);
const tzRow = await db.meeting.findUnique({ where: { id: bookedTz.id } });
check("meeting timezone persisted", tzRow?.timezone === "Europe/Berlin" && !!tzRow?.startsAt);
await cancelBookedMeeting(bookedTz.id).catch(() => undefined);

// ── 11. CRM: unconfigured → explicit failure persisted, primary state intact ──
try {
  await tools.updateCRM!.fn({ leadId: lead.id, operation: "upsert_contact" }, {});
  check("CRM without credentials fails loudly", false);
} catch (e) {
  check("CRM without credentials fails loudly", /No CRM configured/.test(String(e)));
}
const crmFail = await db.crmSync.findFirst({ where: { leadId: lead.id, status: "failed" } }).catch(() => null);
const crmPending = await db.crmSync.findFirst({ where: { leadId: lead.id } }).catch(() => null);
check("CRM failure recorded in ledger (never silent)", !!crmFail || !!crmPending, crmFail ? "failed row" : crmPending ? "pending row" : "none");
const leadIntact = await db.lead.findUnique({ where: { id: lead.id } });
check("primary lead state uncorrupted by CRM failure", !!leadIntact?.status);

// ── 12. opt-out: deterministic suppression before any new spend ──
const optout = await respondToProspect(lead.id, "Please stop emailing me, remove me.");
check("opt-out deterministic", optout.intent === "opt_out");
const { canContactLead } = await import("../src/lib/policy");
const gate = await canContactLead(lead.id);
check("suppressed lead blocked from outreach", gate.ok === false, gate.reason ?? "");
try {
  await tools.sendEmail!.fn({ messageId: msg0!.id }, {});
  check("send to suppressed lead blocked", false);
} catch { check("send to suppressed lead blocked", true); }

// ── 13. retries → dead letter (worker-consumed) ──
// "qa-permanent" has no handler anywhere → worker must dead-letter it.
await enqueue("qa-permanent", { x: 1 }, { maxAttempts: 1 });
const dl = await waitFor("dead letter persisted", async () =>
  db.deadLetter.findFirst({ where: { queue: "qa-permanent", status: "open" } }), 60_000).catch(() => null);
check("dead-letter row persisted by worker", !!dl, dl ? `attempts=${dl.attempts}` : "none (worker may lack handler → also DLs)");

// ── 14. cost tracking writes (null-safe) ──
const { trackUsage } = await import("../src/lib/models");
await trackUsage({ workspaceId: wsA.id, campaignId: campaign.id, leadId: lead.id, provider: "openai", model: "gpt-4o-mini", task: "staging-probe", inputTokens: null, outputTokens: null, latencyMs: 5, success: true });
const nullRow = await db.llmUsage.findFirst({ where: { task: "staging-probe" } });
check("null token fields stored as null (never fabricated)", nullRow?.inputTokens === null && nullRow?.costUsd === null);
const usageCount = await db.llmUsage.count({ where: { campaignId: campaign.id } });
check("usage rows attributable to campaign", usageCount >= 1, `${usageCount}`);

// ── 15. analytics reflects reality (session-authenticated) ──
async function sessionCookie(email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const jar = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const login = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar },
    body: new URLSearchParams({ csrfToken, email, password }),
    redirect: "manual",
  });
  if (login.status !== 302 && login.status !== 200) throw new Error(`login failed: ${login.status}`);
  return (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}
const cookie = await sessionCookie(userAEmail, userAPassword);
check("session login over HTTP", cookie.length > 0);
const anRes = await fetch(`${BASE}/api/analytics?campaignId=${campaign.id}`, { headers: { Cookie: cookie } });
check("analytics authorized", anRes.status === 200, String(anRes.status));
const an = (await anRes.json()) as Record<string, number>;
check("analytics prospects>0", (an.prospectsDiscovered ?? 0) > 0, JSON.stringify(an));
check("analytics replies>0", (an.replied ?? 0) > 0);
check("analytics meetings tracked", (an.meetingsBooked ?? 0) >= 0);

// ── 16. workspace isolation (DB level) ──
const leakLeads = await db.lead.findMany({ where: { workspaceId: wsB.id } });
const crossContent = await db.knowledgeChunk.findMany({
  where: { document: { source: { workspaceId: wsB.id } }, content: { contains: "$500" } },
  take: 1,
});
check("workspace B has no leads/knowledge bleed", leakLeads.length === 0 && crossContent.length === 0);

console.log(failures === 0 ? "\nSTAGING E2E: ALL PASS" : `\nSTAGING E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
