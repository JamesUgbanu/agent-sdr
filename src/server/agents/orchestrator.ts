import { z } from "zod";
import { db, J } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { scoreLead, WeightsSchema } from "@/lib/scoring";
import { canContactLead, assertNoFabrication } from "@/lib/policy";
import { transitionLead, canTransition } from "@/lib/state-machine";
import { getLLMProvider } from "@/lib/llm";
import { resolveModel } from "@/lib/models";
import { verifyEmailCached, updateCRM, calendarForWorkspace, bookMeeting, cancelBookedMeeting } from "@/lib/integrations";
import { respondToProspect } from "@/lib/conversation";
import { withinWorkingHours } from "@/lib/policy";
import { prospectProvider } from "@/lib/prospect-providers";
import { checkBudgets, newContext, BudgetError, MAX_IDENTICAL_CALLS, MAX_CONSECUTIVE_ERRORS, MAX_AGENT_STEPS } from "@/lib/budgets";
import { isRetryableError } from "@/lib/queue";
import { zodToJsonSchema, stableArgs } from "@/lib/tool-schema";
import type { ToolChoice, ToolCatalogEntry } from "@/lib/llm";

// ── Tool registry: the ONLY way the LLM touches the world ──
export type ToolFn = (args: Record<string, unknown>, ctx: { leadId?: string; campaignId?: string }) => Promise<unknown>;

async function emit(kind: string, message: string, ids: { leadId?: string; campaignId?: string }, payload?: unknown) {
  try {
    await db.agentEvent.create({ data: { kind, message, ...ids, payload: J(payload ?? {}) } });
    await db.activityLog.create({
      data: { leadId: ids.leadId, campaignId: ids.campaignId, actor: "agent", action: kind, detail: J(payload ?? { message }) },
    });
  } catch { /* db may be unmigrated in preview */ }
}

export const tools: Record<string, { schema: z.ZodTypeAny; fn: ToolFn; destructive: boolean }> = {
  searchProspects: {
    schema: z.object({ campaignId: z.string() }),
    destructive: false,
    fn: async (raw: Record<string, unknown>) => {
      const { campaignId } = raw as { campaignId: string };
      const campaign = await db.campaign.findUnique({ where: { id: campaignId as string } });
      if (!campaign) throw new Error("campaign not found");
      const provider = prospectProvider(); // Apollo/Hunter/PDL via PROSPECT_PROVIDER; seed for dev/tests
      const companies = await provider.searchCompanies({
        industries: campaign.targetIndustries, geo: campaign.targetGeography ?? undefined,
        sizeMin: campaign.companySizeMin ?? undefined, sizeMax: campaign.companySizeMax ?? undefined,
        technologies: campaign.technologies, query: campaign.targetIndustries[0] ?? "SaaS", limit: 5,
      });
      let created = 0, skippedSuppressed = 0;
      const suppressed = await db.suppression.findMany({
        where: { workspaceId: campaign.workspaceId },
      }).catch(() => []);
      const badDomains = new Set((suppressed ?? []).map((s) => s.domain).filter(Boolean) as string[]);
      const badEmails = new Set((suppressed ?? []).map((s) => s.email).filter(Boolean) as string[]);
      for (const c of companies) {
        if (c.domain && badDomains.has(c.domain.toLowerCase())) { skippedSuppressed++; continue; }
        const company = await db.company.upsert({
          where: { workspaceId_domain: { workspaceId: campaign.workspaceId, domain: c.domain ?? `${Date.now()}.x` } },
          update: { name: c.name, industry: c.industry, employeeCount: c.employeeCount, location: c.location },
          create: { workspaceId: campaign.workspaceId, name: c.name, domain: c.domain, industry: c.industry, employeeCount: c.employeeCount, location: c.location },
        });
        const contacts = await provider.searchContacts({ companyDomain: c.domain, titles: campaign.jobTitles });
        for (const ct of contacts) {
          if (ct.email && badEmails.has(ct.email.toLowerCase())) { skippedSuppressed++; continue; }
          const fullName = `${ct.firstName ?? ""} ${ct.lastName ?? ""}`.trim();
          // Dedupe: re-running prospecting must not clone contacts/leads.
          const existingContact = fullName
            ? await db.contact.findFirst({ where: { companyId: company.id, fullName } }).catch(() => null)
            : null;
          const contact = existingContact ?? await db.contact.create({
            data: { workspaceId: campaign.workspaceId, companyId: company.id, firstName: ct.firstName, lastName: ct.lastName, fullName, title: ct.title, emailConfidence: "unknown" },
          });
          await db.lead.upsert({
            where: { campaignId_contactId: { campaignId: campaign.id, contactId: contact.id } },
            update: {},
            create: { workspaceId: campaign.workspaceId, campaignId: campaign.id, companyId: company.id, contactId: contact.id, status: "NEW" },
          });
          if (!existingContact) {
            created++;
            await emit("lead.discovered", `Lead discovered: ${contact.fullName} @ ${company.name}`, { campaignId, leadId: undefined }, { company: company.name });
          }
        }
      }
      await enqueue("enrichment", { campaignId });
      return { companies: companies.length, leads: created, skippedSuppressed };
    },
  },

  researchCompany: {
    schema: z.object({ leadId: z.string() }),
    destructive: false,
    fn: async ({ leadId }) => {
      const lead = await db.lead.findUnique({ where: { id: leadId as string }, include: { company: true, contact: true, campaign: true } });
      if (!lead?.company) throw new Error("lead/company not found");
      const domain = (lead.company.domain ?? "").toLowerCase();
      const { getCachedResearch, putCachedResearch } = await import("@/lib/research-cache");
      let summary = "", evidence: Array<Record<string, unknown>> = [], cacheHit = false;
      if (domain) {
        const cached = await getCachedResearch(lead.workspaceId, "company", domain, "website");
        if (cached.hit && cached.payload) {
          summary = cached.payload.summary; evidence = cached.payload.evidence; cacheHit = true;
        }
      }
      if (domain && !cacheHit) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8000);
          const res = await fetch(`https://${domain}`, { signal: ctrl.signal, redirect: "follow" }).catch(() => null);
          clearTimeout(t);
          if (res?.ok) {
            const html = (await res.text()).slice(0, 8000);
            const title = html.match(/<title>(.*?)<\/title>/i)?.[1]?.slice(0, 200);
            const hiring = /careers|we('|’)?re hiring|open roles/i.test(html);
            if (title) evidence.push({ source_url: `https://${domain}`, source_type: "website", retrieved_at: new Date().toISOString(), claim: `Homepage title: ${title}`, confidence: 0.7 });
            if (hiring) evidence.push({ source_url: `https://${domain}/careers`, source_type: "careers_page", retrieved_at: new Date().toISOString(), claim: "Careers page signals active hiring", confidence: 0.6 });
          }
        } catch { /* offline-safe */ }
      }
      if (!summary) {
        summary = `${lead.company.name} (${lead.company.industry ?? "technology"}) — ${lead.company.employeeCount ?? "?"} employees, ${lead.company.location ?? "unknown geo"}.`;
      }
      if (domain && !cacheHit) {
        await putCachedResearch(lead.workspaceId, "company", domain, "website", { summary, evidence }, { provider: "website-fetch" });
      }
      await db.leadResearch.create({
        data: { leadId: lead.id, companySummary: summary, signals: J(evidence), painPointHypotheses: ["manual outbound is slow", "follow-up consistency"], relevantProducts: [lead.campaign.offer ?? "AI automation"], evidence: J(evidence) },
      });
      for (const e of evidence.slice(0, 4)) {
        await db.leadSignal.create({
          data: { leadId: lead.id, type: (e as { source_type: string }).source_type === "careers_page" ? "new_hiring" : "website_change", strength: 0.6, source: String((e as { source_url: string }).source_url), evidence: J(e) },
        });
      }
      await transitionLead(lead.id, "QUALIFIED", { note: "research complete" }).catch(async () => {
        // Never regress a lead that already moved past research (e.g. re-research
        // of a CONTACTED lead must not move it back to RESEARCHING).
        const cur = await db.lead.findUnique({ where: { id: lead.id } }).catch(() => null);
        if (cur && canTransition(cur.status, "RESEARCHING")) {
          await db.lead.update({ where: { id: lead.id }, data: { status: "RESEARCHING" } });
        }
      });
      await emit("research.completed", `Researched ${lead.company.name}: ${evidence.length} evidence items`, { leadId: lead.id, campaignId: lead.campaignId });
      await enqueue("qualification", { leadId: lead.id });
      return { summary, evidenceCount: evidence.length, cacheHit };
    },
  },

  scoreLead: {
    schema: z.object({ leadId: z.string() }),
    destructive: false,
    fn: async ({ leadId }) => {
      const lead = await db.lead.findUnique({ where: { id: leadId as string }, include: { campaign: true, company: true, contact: true, signals: true } });
      if (!lead) throw new Error("lead not found");
      const weights = WeightsSchema.parse((lead.campaign.scoringWeights as object) ?? {});
      const signalStrength = Math.min(1, lead.signals.length * 0.3);
      const { score, factors } = scoreLead({
        companyMatch: lead.company ? 0.8 : 0.3,
        roleMatch: lead.contact?.title && lead.campaign.jobTitles.some((t: string) => lead.contact!.title!.toLowerCase().includes(t.toLowerCase().split(" ")[0] ?? t.toLowerCase())) ? 1 : 0.5,
        geoMatch: 0.8, intentMatch: 0.6, signalStrength,
        dataConfidence: lead.contact?.emailConfidence === "verified" ? 1 : 0.5,
      }, weights);
      await db.leadScore.create({ data: { leadId: lead.id, score, breakdown: J(factors), reasoning: "Deterministic weighted factors; no black-box LLM score.", evidence: J({ signals: lead.signals.length }) } });
      const next = score >= lead.campaign.minScoreToContact ? "READY_FOR_OUTREACH" : "DISQUALIFIED";
      // Never regress post-outreach states: re-scoring a CONTACTED/replied lead
      // records the score but leaves the conversation state untouched.
      const preOutreach = ["NEW", "RESEARCHING", "QUALIFIED", "READY_FOR_OUTREACH"].includes(lead.status);
      await db.lead.update({ where: { id: lead.id }, data: { score, scoreBreakdown: J(factors), scoreReasoning: `score=${score}`, ...(preOutreach ? { status: next } : {}) } });
      await emit("lead.scored", `Scored ${score}: ${JSON.stringify(factors)}`, { leadId: lead.id, campaignId: lead.campaignId });
      if (next === "READY_FOR_OUTREACH") await enqueue("personalization", { leadId: lead.id });
      return { score, factors };
    },
  },

  generateMessage: {
    schema: z.object({ leadId: z.string(), step: z.number().int().min(0).max(100).default(0) }),
    destructive: false,
    fn: async ({ leadId, step }) => {
      const lead = await db.lead.findUnique({ where: { id: leadId as string }, include: { campaign: true, company: true, contact: true } });
      if (!lead) throw new Error("lead not found");
      const contactable = await canContactLead(lead.id);
      if (!contactable.ok) throw new Error(`Draft blocked: ${contactable.reason}`);
      const research = await db.leadResearch.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
      const evidence = ((research?.evidence as Array<{ claim: string }>) ?? []).map((e) => e.claim);
      const llm = getLLMProvider();
      let draft: { subject: string; body: string; personalization_points: string[]; confidence: number; cta: string };
      const mc = await resolveModel("personalization", lead.workspaceId);
      try {
        draft = await llm.generateStructured(
          `Write concise B2B cold outreach (step ${step}). Campaign offer: ${lead.campaign.offer}. Value: ${lead.campaign.valueProposition}. Prospect: ${lead.contact?.fullName}, ${lead.contact?.title} at ${lead.company?.name}. Evidence (only use these facts, never invent): ${JSON.stringify(evidence)}. Return JSON {subject, body, personalization_points, confidence, cta}. No "Hope you're doing well". Max 120 words.`,
          null, { model: mc.model, temperature: mc.temperature ?? 0.4, tracking: { workspaceId: lead.workspaceId, campaignId: lead.campaignId, leadId: lead.id, task: "personalization" } },
        );
      } catch {
        // Deterministic evidence-backed fallback — never hallucinates signals.
        const hook = evidence[0] ? `Noticed: ${evidence[0]}.` : `${lead.company?.name ?? "Your team"} fits our ${lead.campaign.targetIndustries[0] ?? "SaaS"} ICP.`;
        draft = {
          subject: `Idea for ${lead.company?.name ?? "your team"} — ${lead.campaign.offer ?? "automation"}`,
          body: `Hi ${lead.contact?.firstName ?? "there"} — ${hook}\n\nWe help teams like yours with ${lead.campaign.valueProposition ?? lead.campaign.offer ?? "AI automation"}. Worth a 15-min look?\n\n— ${lead.campaign.senderName ?? "SDR"}`,
          personalization_points: evidence.slice(0, 2),
          confidence: evidence.length ? 0.75 : 0.45,
          cta: "15-min intro call",
        };
      }
      assertNoFabrication(draft.body, evidence);
      const idemKey = `${lead.id}-step-${step}`;
      const existing = await db.message.findUnique({ where: { idempotencyKey: idemKey } }).catch(() => null);
      if (existing) return { messageId: existing.id, status: existing.status, deduped: true };
      const thread = await db.messageThread.upsert({
        where: { id: `${lead.id}-main` },
        update: {},
        create: { id: `${lead.id}-main`, leadId: lead.id, subject: draft.subject, channel: "email" },
      }).catch(() => db.messageThread.create({ data: { leadId: lead.id, subject: draft.subject, channel: "email" } }));
      const gate = lead.campaign.approvalPolicy === "autonomous" || (lead.campaign.approvalPolicy === "assisted" && draft.confidence >= lead.campaign.approvalConfidenceThreshold);
      const message = await db.message.create({
        data: {
          threadId: thread.id, direction: "outbound", subject: draft.subject, body: draft.body,
          personalizationPoints: draft.personalization_points,
          evidenceUsed: J(research?.evidence ?? {}),
          confidence: draft.confidence, status: gate ? "approved" : "pending_approval",
          idempotencyKey: idemKey, sequenceStep: step as number,
        },
      }).catch(async (e) => {
        // Concurrent duplicate draft: return the winner instead of failing.
        if (String(e).includes("Unique constraint")) {
          const won = await db.message.findUnique({ where: { idempotencyKey: idemKey } }).catch(() => null);
          if (won) return won;
        }
        throw e;
      });
      if (!gate) {
        await db.approval.create({ data: { leadId: lead.id, messageId: message.id, status: "pending", reason: `confidence ${draft.confidence} < threshold` } });
        await emit("approval.requested", "Message awaiting human approval", { leadId: lead.id, campaignId: lead.campaignId });
      } else {
        await db.approval.create({ data: { leadId: lead.id, messageId: message.id, status: "auto_approved", reason: "policy gate passed" } });
        await enqueue("outreach", { leadId: lead.id, messageId: message.id });
      }
      return { messageId: message.id, status: message.status };
    },
  },

  sendEmail: {
    schema: z.object({ messageId: z.string() }),
    destructive: true,
    fn: async ({ messageId }) => {
      const msg = await db.message.findUnique({ where: { id: messageId as string }, include: { thread: { include: { lead: { include: { campaign: true, contact: true } } } } } });
      if (!msg) throw new Error("message not found");
      const lead = msg.thread.lead;
      const gate = await canContactLead(lead.id);
      if (!gate.ok) throw new Error(`Send blocked: ${gate.reason}`);
      // Idempotency: exact step already sent?
      const dup = await db.message.findFirst({ where: { providerMessageId: { not: null }, thread: { leadId: lead.id }, sequenceStep: msg.sequenceStep, status: { in: ["sent", "delivered"] } } });
      if (dup) return { skipped: true, reason: "already-sent", providerMessageId: dup.providerMessageId };
      const to = lead.contact?.email;
      if (!to) throw new Error("No recipient email — never invent contact info");
      // Daily limit check
      const dayAgo = new Date(Date.now() - 86400_000);
      const sentToday = await db.message.count({ where: { thread: { lead: { campaignId: lead.campaignId } }, status: { in: ["sent", "delivered"] }, sentAt: { gte: dayAgo } } });
      if (sentToday >= lead.campaign.dailySendLimit) throw new Error("daily-send-limit reached");
      try {
        // Atomic claim: only one worker can move this message into sending.
        // Concurrent senders lose the race here instead of double-sending.
        // A message stuck in "sending" (crashed worker) is deliberately NOT
        // claimable: provider state must be reconciled before any resend.
        const claim = await db.message.updateMany({
          where: { id: msg.id, status: { in: ["approved", "failed"] } },
          data: { status: "sending" },
        });
        if (claim.count === 0) {
          const current = await db.message.findUnique({ where: { id: msg.id } }).catch(() => null);
          if (current && ["sent", "delivered"].includes(current.status)) {
            return { skipped: true, reason: "already-sent", providerMessageId: current.providerMessageId };
          }
          throw new Error(`Send conflict: message is ${current?.status ?? "gone"} — reconcile provider state before resending`);
        }
        const { workspaceChannel, sendWithFallback } = await import("@/lib/email");
        // Workspace connection credentials win; env chain remains as fallback.
        const ws = await workspaceChannel(lead.workspaceId);
        const res = await sendWithFallback(
          { to, subject: msg.subject ?? "", body: msg.body, idempotencyKey: msg.idempotencyKey ?? msg.id },
          undefined, ws?.name, ws?.channel,
        );
        await db.message.update({ where: { id: msg.id }, data: { status: "sent", providerMessageId: res.providerMessageId, sentAt: new Date() } });
        await db.lead.update({ where: { id: lead.id }, data: { status: lead.status === "READY_FOR_OUTREACH" ? "CONTACTED" : "FOLLOW_UP" } });
        // Schedule next sequence step
        const seq = await db.sequence.findFirst({ where: { campaignId: lead.campaignId }, include: { steps: { orderBy: { order: "asc" } } } });
        const nextIdx = (msg.sequenceStep ?? 0) + 1;
        const nextStep = seq?.steps[nextIdx];
        if (nextStep) {
          await db.leadSequenceState.upsert({
            where: { leadId: lead.id },
            update: { currentStep: nextIdx, nextRunAt: new Date(Date.now() + nextStep.dayOffset * 86400_000) },
            create: { leadId: lead.id, sequenceId: seq!.id, currentStep: nextIdx, nextRunAt: new Date(Date.now() + nextStep.dayOffset * 86400_000) },
          });
          await enqueue("personalization", { leadId: lead.id }, { delayMs: Math.min(nextStep.dayOffset * 86400_000, 60_000) });
        }
        await emit("email.sent", `Email sent to ${to}`, { leadId: lead.id, campaignId: lead.campaignId }, { providerMessageId: res.providerMessageId });
        return res;
      } catch (e) {
        // Do NOT blindly retry non-idempotent send: reconcile first.
        await db.message.update({ where: { id: msg.id }, data: { status: "failed", error: String(e) } });
        throw e;
      }
    },
  },

  classifyReply: {
    schema: z.object({ messageId: z.string() }),
    destructive: false,
    fn: async ({ messageId }) => {
      const msg = await db.message.findUnique({ where: { id: messageId as string }, include: { thread: { include: { lead: true } } } });
      if (!msg) throw new Error("message not found");
      const text = msg.body.toLowerCase();
      const rules: Array<[string, RegExp]> = [
        ["unsubscribe", /unsubscribe|remove me|do not (contact|email)/],
        ["not_interested", /not interested|no thanks|pass|not a (fit|priority)/],
        ["out_of_office", /out of office|ooo|on leave|auto.?reply/],
        ["meeting_request", /let'?s (meet|talk|chat)|book|calendar|tuesday|wednesday|call (tomorrow|next week)/],
        ["pricing_question", /how much|pricing|cost|quote/],
        ["referral", /talk to .*@|contact (my|our) colleague|forward/],
        ["interested", /interested|tell me more|sounds (good|great)|let'?s explore/],
      ];
      let classification = "unclear", confidence = 0.4;
      for (const [c, re] of rules) {
        if (re.test(text)) { classification = c; confidence = c === "unclear" ? 0.4 : 0.85; break; }
      }
      try {
        const llm = getLLMProvider();
        if (llm.name !== "console") {
          const mc = await resolveModel("classification", msg.thread.lead.workspaceId);
          const r = await llm.generateStructured<{ classification: string; confidence: number; reason: string }>(
            `Classify this sales reply into [interested, meeting_request, question, not_interested, unsubscribe, out_of_office, wrong_person, referral, pricing_question, objection, unclear]. Reply: """${msg.body.slice(0, 2000)}""" Return JSON {classification, confidence, reason}.`,
            null, { model: mc.model, temperature: 0, tracking: { workspaceId: msg.thread.lead.workspaceId, campaignId: msg.thread.lead.campaignId, leadId: msg.thread.leadId, task: "classification" } },
          );
          classification = r.classification; confidence = r.confidence;
          const known = ["interested", "meeting_request", "question", "not_interested", "unsubscribe", "out_of_office", "wrong_person", "referral", "pricing_question", "objection", "unclear"];
          if (!known.includes(classification)) { classification = "unclear"; confidence = Math.min(confidence, 0.4); }
        }
      } catch { /* rule fallback stands */ }
      const requiresHuman = confidence < 0.65 || classification === "unclear";
      await db.message.update({ where: { id: msg.id }, data: { classification, classificationConfidence: confidence } });
      const leadId = msg.thread.leadId;
      if (classification === "unsubscribe") {
        const lead = await db.lead.findUnique({ where: { id: leadId }, include: { contact: true } });
        if (lead?.contact?.email) {
          await db.suppression.upsert({
            where: { id: `${lead.workspaceId}-${lead.contact.email}` },
            update: {}, create: { id: `${lead.workspaceId}-${lead.contact.email}`, workspaceId: lead.workspaceId, email: lead.contact.email.toLowerCase(), reason: "unsubscribed" },
          }).catch(() => db.suppression.create({ data: { workspaceId: lead!.workspaceId, email: lead!.contact!.email!.toLowerCase(), reason: "unsubscribed" } }));
        }
        await db.lead.update({ where: { id: leadId }, data: { status: "UNSUBSCRIBED" } });
        await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "unsubscribed" } }).catch(() => undefined);
      } else if (classification === "not_interested") {
        await db.lead.update({ where: { id: leadId }, data: { status: "NOT_INTERESTED" } });
        await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "not-interested" } }).catch(() => undefined);
      } else if (classification === "interested" || classification === "meeting_request") {
        await db.lead.update({ where: { id: leadId }, data: { status: "MEETING_REQUESTED" } });
        await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "replied-positive" } }).catch(() => undefined);
        await enqueue("meeting", { leadId });
      } else if (requiresHuman) {
        // Human handoff with full brief: reviewer gets everything needed to decide.
        const brief = await db.lead.findUnique({
          where: { id: leadId }, include: { contact: true, company: true, scores: { orderBy: { createdAt: "desc" }, take: 1 } },
        }).catch(() => null);
        await db.agentTask.create({
          data: {
            leadId, type: "review_reply", status: "open",
            payload: J({
              messageId, classification, confidence,
              replyExcerpt: msg.body.slice(0, 500),
              prospect: brief?.contact ? { name: brief.contact.fullName, title: brief.contact.title, email: brief.contact.email } : undefined,
              company: brief?.company ? { name: brief.company.name, domain: brief.company.domain } : undefined,
              score: brief?.score ?? brief?.scores?.[0]?.score ?? undefined,
            }),
          },
        });
        if (["question", "pricing_question", "objection"].includes(classification)) {
          // Draft a knowledge-grounded response into the approval queue; human decides.
          await enqueue("conversation", { leadId, prospectMessage: msg.body.slice(0, 2000) });
        }
      } else {
        await db.lead.update({ where: { id: leadId }, data: { status: "REPLIED" } });
        await db.leadSequenceState.update({ where: { leadId }, data: { stoppedReason: "replied" } }).catch(() => undefined);
      }
      await emit("reply.classified", `${classification} (${confidence})`, { leadId, campaignId: msg.thread.lead.campaignId });
      return { classification, confidence, requiresHuman };
    },
  },

  verifyEmail: {
    schema: z.object({ leadId: z.string() }),
    destructive: false,
    fn: async ({ leadId }) => {
      const lead = await db.lead.findUnique({
        where: { id: leadId as string }, include: { contact: true },
      });
      if (!lead?.contact?.email) throw new Error("No email to verify — never invent contact info");
      const result = await verifyEmailCached(lead.workspaceId, lead.contact.email);
      await db.contact.update({
        where: { id: lead.contact.id },
        data: {
          emailConfidence: result.status === "deliverable" ? "verified"
            : result.status === "undeliverable" ? "low"
            : result.status === "unavailable" ? "unknown" : "medium",
        },
      }).catch(() => undefined);
      await emit("email.verified", `${lead.contact.email}: ${result.status}`, { leadId: lead.id, campaignId: lead.campaignId }, result);
      return result;
    },
  },

  scheduleFollowUp: {
    schema: z.object({ leadId: z.string(), dayOffset: z.number().min(0).max(30).default(3) }),
    destructive: false,
    fn: async ({ leadId, dayOffset }) => {
      const lead = await db.lead.findUnique({
        where: { id: leadId as string }, include: { campaign: true, sequenceState: true },
      });
      if (!lead) throw new Error("lead not found");
      if (["REPLIED", "MEETING_REQUESTED", "MEETING_BOOKED", "NOT_INTERESTED", "UNSUBSCRIBED", "BOUNCED", "DISQUALIFIED", "DO_NOT_CONTACT"].includes(lead.status)) {
        throw new Error(`Follow-up blocked: lead is ${lead.status}`);
      }
      const gate = await canContactLead(lead.id);
      if (!gate.ok) throw new Error(`Follow-up blocked: ${gate.reason}`);
      const nextRunAt = new Date(Date.now() + (dayOffset as number) * 86400_000);
      if (!withinWorkingHours(lead.campaign.timezone, lead.campaign.workingHoursStart, lead.campaign.workingHoursEnd, nextRunAt)) {
        nextRunAt.setUTCHours(10, 0, 0, 0); // shift into working hours instead of sending at night
      }
      const key = `${lead.id}-followup-${lead.sequenceState?.currentStep ?? 0}`;
      if (lead.sequenceState?.nextRunAt && lead.sequenceState.nextRunAt > new Date()) {
        return { skipped: true, reason: "already-scheduled", nextRunAt: lead.sequenceState.nextRunAt };
      }
      const seqId = lead.sequenceState?.sequenceId
        ?? (await db.sequence.findFirst({ where: { campaignId: lead.campaignId } }))?.id;
      await db.leadSequenceState.upsert({
        where: { leadId: lead.id },
        update: { nextRunAt },
        create: { leadId: lead.id, sequenceId: seqId, currentStep: 0, nextRunAt },
      });
      const delayMs = nextRunAt.getTime() - Date.now();
      await enqueue("personalization", { leadId: lead.id }, { delayMs, idempotencyKey: key, workspaceId: lead.workspaceId });
      await emit("followup.scheduled", `Follow-up scheduled for ${nextRunAt.toISOString()}`, { leadId: lead.id, campaignId: lead.campaignId });
      return { scheduled: true, nextRunAt: nextRunAt.toISOString() };
    },
  },

  updateCRM: {
    schema: z.object({
      leadId: z.string(),
      operation: z.enum(["upsert_contact", "add_note", "create_deal", "create_activity"]).default("upsert_contact"),
      note: z.string().optional(), title: z.string().optional(),
      amount: z.number().optional(), stage: z.string().optional(),
      type: z.string().optional(), body: z.string().optional(),
    }),
    destructive: false,
    fn: async (args) => {
      const { leadId, operation, ...rest } = args as { leadId: string; operation: "upsert_contact" | "add_note" | "create_deal" | "create_activity"; [k: string]: unknown };
      const result = await updateCRM(leadId, operation, rest as Record<string, string | number | undefined>);
      const lead = await db.lead.findUnique({ where: { id: leadId } });
      await emit("crm.synced", `${operation}: ${result.externalId ?? "ok"}`, { leadId, campaignId: lead?.campaignId }, result);
      return result;
    },
  },

  checkCalendarAvailability: {
    schema: z.object({
      leadId: z.string(), durationMin: z.number().min(15).max(120).default(30),
      from: z.string().optional(), to: z.string().optional(),
    }),
    destructive: false,
    fn: async ({ leadId, durationMin, from, to }) => {
      const lead = await db.lead.findUnique({ where: { id: leadId as string }, include: { campaign: true } });
      if (!lead) throw new Error("lead not found");
      const cal = await calendarForWorkspace(lead.workspaceId);
      const slots = await cal.getAvailability({
        durationMin: durationMin as number,
        from: from as string | undefined, to: to as string | undefined,
        timezone: lead.campaign.timezone,
      });
      await emit("calendar.availability", `${slots.length} slots via ${cal.name}`, { leadId: lead.id, campaignId: lead.campaignId }, { count: slots.length });
      return { provider: cal.name, slots };
    },
  },

  scheduleMeeting: {
    schema: z.object({
      leadId: z.string(), start: z.string(), end: z.string(), title: z.string().optional(),
    }),
    destructive: true,
    fn: async ({ leadId, start, end, title }) => {
      const result = await bookMeeting({
        leadId: leadId as string, start: start as string, end: end as string,
        title: title as string | undefined,
      });
      await emit("meeting.booked", `Meeting ${result.id}`, { leadId: leadId as string }, result);
      return result;
    },
  },

  cancelMeeting: {
    schema: z.object({ meetingId: z.string() }),
    destructive: true,
    fn: async ({ meetingId }) => cancelBookedMeeting(meetingId as string),
  },

  respondToProspect: {
    schema: z.object({ leadId: z.string(), prospectMessage: z.string().min(1) }),
    destructive: false,
    fn: async ({ leadId, prospectMessage }) => {
      const res = await respondToProspect(leadId as string, prospectMessage as string);
      const lead = await db.lead.findUnique({ where: { id: leadId as string } });
      // Conversational replies enter the approval queue unless the campaign is autonomous
      // AND the answer is knowledge-backed (not a handoff).
      const auto = lead?.campaignId && !res.approvalRequired && !res.handoff
        && (await db.campaign.findUnique({ where: { id: lead.campaignId } }))?.approvalPolicy === "autonomous";
      const thread = await db.messageThread.findFirst({ where: { leadId: leadId as string } });
      if (thread) {
        const msg = await db.message.create({
          data: {
            threadId: thread.id, direction: "outbound", subject: `Re: ${thread.subject ?? "follow-up"}`,
            body: res.reply, status: auto ? "approved" : "pending_approval",
            confidence: res.confidence, evidenceUsed: J({ knowledge: res.knowledgeUsed }),
            personalizationPoints: [], idempotencyKey: `${leadId}-convo-${Date.now()}`,
          },
        });
        await db.approval.create({
          data: {
            leadId: leadId as string, messageId: msg.id,
            status: auto ? "auto_approved" : "pending",
            reason: res.handoff ? `handoff: ${res.intent}` : `conversational reply (${res.intent}, conf ${res.confidence})`,
          },
        });
        if (auto) await enqueue("outreach", { leadId, messageId: msg.id });
      }
      await emit("conversation.replied", `${res.intent} (handoff=${res.handoff})`, { leadId: leadId as string, campaignId: lead?.campaignId }, res);
      return res;
    },
  },
};

// ── Agentic decision loop ──────────────────────────────────────────────
// Tools the run may choose from, per run type. This is a PERMISSION SET, not a
// sequence: the LLM decides order, repetition, and termination within it.
const ALLOWED_TOOLS: Record<string, string[]> = {
  prospecting: ["searchProspects"],
  enrichment: ["verifyEmail", "researchCompany"],
  research: ["researchCompany"],
  qualification: ["scoreLead"],
  personalization: ["generateMessage"],
  outreach: ["sendEmail", "updateCRM"],
  reply: ["classifyReply"],
  followup: ["scheduleFollowUp"],
  crm: ["updateCRM"],
  meeting: ["checkCalendarAvailability", "scheduleMeeting", "cancelMeeting"],
  conversation: ["respondToProspect"],
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  searchProspects: "Discover companies and decision-maker contacts matching the campaign ICP; creates leads.",
  verifyEmail: "Check deliverability of the lead's email address. Returns explicit unavailable when unconfigured.",
  researchCompany: "Fetch and store evidence-backed company research and buying signals (cached per workspace).",
  scoreLead: "Compute the explained ICP-fit score and route qualified leads onward.",
  generateMessage: "Draft evidence-backed outreach. Low-confidence drafts require human approval.",
  sendEmail: "Send an approved message. Enforces suppression, limits, working hours, idempotency.",
  classifyReply: "Classify an inbound reply and apply stop/route/suppress rules.",
  scheduleFollowUp: "Schedule the next sequence step honoring limits, hours, and idempotency.",
  updateCRM: "Sync lead/contact/deal/activity to the configured CRM with a persisted ledger.",
  checkCalendarAvailability: "Return real availability slots. Never invents times.",
  scheduleMeeting: "Book a meeting only inside verified availability; prevents duplicates.",
  cancelMeeting: "Cancel a booked meeting provider-side and locally.",
  respondToProspect: "Draft a knowledge-grounded reply; hands off when knowledge is insufficient.",
};

const OBJECTIVES: Record<string, string> = {
  prospecting: "Discover new prospects for the campaign without duplicating or contacting suppressed records.",
  enrichment: "Establish email deliverability and evidence-backed research for the lead.",
  research: "Build evidence-backed company research and signals for the lead.",
  qualification: "Score the lead and determine whether it is worth contacting.",
  personalization: "Produce a personalized, evidence-backed message ready for approval or sending.",
  outreach: "Deliver approved outreach exactly once and synchronize the CRM.",
  reply: "Classify the inbound reply and apply stop, suppress, or routing rules.",
  followup: "Schedule the next appropriate follow-up or stop when the lead state forbids it.",
  crm: "Synchronize the lead state to the configured CRM.",
  meeting: "Establish availability and book or cancel meetings only for real slots.",
  conversation: "Respond helpfully using only authorized knowledge; hand off when knowledge is insufficient.",
};

export interface HistoryEntry {
  tool: string;
  ok: boolean;
  summary: string;
}

export interface StateSnapshot {
  runType: string;
  objective: string;
  iteration: number;
  lead?: { id: string; workspaceId: string; status: string; score: number | null; email: string | null; title: string | null; company: string | null; domain: string | null } | null;
  campaign?: { id: string; status: string; approvalPolicy: string; minScoreToContact: number } | null;
  contactable?: { ok: boolean; reason?: string };
  sequence?: { currentStep: number; nextRunAt: string | null; stoppedReason: string | null } | null;
  pendingApprovals?: number;
  recentMessages?: Array<{ direction: string; status: string; classification: string | null }>;
  history: HistoryEntry[];
}

export type DecideFn = (snap: StateSnapshot, allowed: string[]) => Promise<ToolChoice>;
export interface RunOpts {
  decide?: DecideFn;
  maxIterations?: number;
}

function summarizeResult(result: unknown): string {
  try {
    const s = JSON.stringify(result);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(result).slice(0, 500);
  }
}

export async function buildSnapshot(
  runType: string, ids: { campaignId?: string; leadId?: string },
  history: HistoryEntry[], iteration: number,
): Promise<StateSnapshot> {
  const snap: StateSnapshot = {
    runType,
    objective: OBJECTIVES[runType] ?? "Advance the lead according to campaign policy.",
    iteration,
    history: history.slice(-8),
  };
  try {
    if (ids.leadId) {
      const lead = await db.lead.findUnique({
        where: { id: ids.leadId },
        include: { contact: true, company: true, campaign: true, sequenceState: true },
      });
      if (lead) {
        snap.lead = {
          id: lead.id, workspaceId: lead.workspaceId, status: lead.status, score: lead.score,
          email: lead.contact?.email ?? null, title: lead.contact?.title ?? null,
          company: lead.company?.name ?? null, domain: lead.company?.domain ?? null,
        };
        snap.campaign = {
          id: lead.campaign.id, status: lead.campaign.status,
          approvalPolicy: lead.campaign.approvalPolicy, minScoreToContact: lead.campaign.minScoreToContact,
        };
        snap.contactable = await canContactLead(lead.id);
        snap.sequence = lead.sequenceState ? {
          currentStep: lead.sequenceState.currentStep,
          nextRunAt: lead.sequenceState.nextRunAt?.toISOString() ?? null,
          stoppedReason: lead.sequenceState.stoppedReason,
        } : null;
        snap.pendingApprovals = await db.approval.count({ where: { leadId: lead.id, status: "pending" } });
        const msgs = await db.message.findMany({
          where: { thread: { leadId: lead.id } }, orderBy: { createdAt: "desc" }, take: 3,
        });
        snap.recentMessages = msgs.map((m) => ({ direction: m.direction, status: m.status, classification: m.classification }));
      }
    } else if (ids.campaignId) {
      const camp = await db.campaign.findUnique({ where: { id: ids.campaignId } });
      if (camp) {
        snap.campaign = { id: camp.id, status: camp.status, approvalPolicy: camp.approvalPolicy, minScoreToContact: camp.minScoreToContact };
      }
    }
  } catch { /* snapshot degrades gracefully; the loop still decides from history */ }
  return snap;
}

function toolCatalog(allowed: string[]): ToolCatalogEntry[] {
  return allowed
    .filter((n) => tools[n])
    .map((n) => ({ name: n, description: TOOL_DESCRIPTIONS[n] ?? n, argsSchema: zodToJsonSchema(tools[n]!.schema) }));
}

export class DecisionError extends Error {}

async function runWorkspaceId(ids: { campaignId?: string; leadId?: string }): Promise<string | null> {
  try {
    if (ids.leadId) {
      const lead = await db.lead.findUnique({ where: { id: ids.leadId }, select: { workspaceId: true } });
      if (lead) return lead.workspaceId;
    }
    if (ids.campaignId) {
      const camp = await db.campaign.findUnique({ where: { id: ids.campaignId }, select: { workspaceId: true } });
      if (camp) return camp.workspaceId;
    }
  } catch { /* unresolved scope → no enforcement possible */ }
  return null;
}

// Deterministic tenant boundary for tool execution: every ID the model passes
// must belong to the run's own workspace. This holds even if the LLM is
// compromised, mistaken, or injected — tools never validate this themselves.
async function enforceToolScope(runWs: string | null, tool: string, args: Record<string, unknown>): Promise<void> {
  if (!runWs) return;
  const check = async (kind: string, id: unknown, resolve: (id: string) => Promise<string | null>) => {
    if (typeof id !== "string" || !id) return;
    const ws = await resolve(id).catch(() => null);
    // Nonexistent resources fail closed: the tool would throw "not found"
    // anyway, but a cross-workspace miss must never be distinguishable here.
    if (ws !== runWs) throw new DecisionError(`${tool}: ${kind} is outside the run workspace`);
  };
  await check("leadId", args.leadId, async (id) =>
    (await db.lead.findUnique({ where: { id }, select: { workspaceId: true } }).catch(() => null))?.workspaceId ?? null);
  await check("campaignId", args.campaignId, async (id) =>
    (await db.campaign.findUnique({ where: { id }, select: { workspaceId: true } }).catch(() => null))?.workspaceId ?? null);
  await check("messageId", args.messageId, async (id) =>
    (await db.message.findUnique({ where: { id }, select: { thread: { select: { lead: { select: { workspaceId: true } } } } } }).catch(() => null))?.thread?.lead?.workspaceId ?? null);
  await check("meetingId", args.meetingId, async (id) =>
    (await db.meeting.findUnique({ where: { id }, select: { lead: { select: { workspaceId: true } } } }).catch(() => null))?.lead?.workspaceId ?? null);
}

function validateDecision(raw: ToolChoice, allowed: string[]): { tool: string; args: Record<string, unknown>; reasoning: string } {
  if (!raw || raw.action !== "tool") throw new DecisionError("decision is not a tool call");
  if (!raw.tool || !allowed.includes(raw.tool) || !tools[raw.tool]) {
    throw new DecisionError(`tool ${String(raw.tool)} is not permitted for this run`);
  }
  const parsed = tools[raw.tool]!.schema.safeParse(raw.args ?? {});
  if (!parsed.success) throw new DecisionError(`invalid args for ${raw.tool}: ${parsed.error.message}`);
  return { tool: raw.tool, args: parsed.data as Record<string, unknown>, reasoning: raw.reasoning ?? "" };
}

function decisionPrompt(snap: StateSnapshot, allowed: string[]): string {
  const catalog = toolCatalog(allowed);
  return [
    "You are the SDR orchestrator. Observe the state and history, then choose the single next action.",
    `RUN_TYPE: ${snap.runType}`,
    `OBJECTIVE: ${snap.objective}`,
    `STATE_JSON: ${JSON.stringify({ lead: snap.lead ?? null, campaign: snap.campaign ?? null, contactable: snap.contactable ?? null, sequence: snap.sequence ?? null, pendingApprovals: snap.pendingApprovals ?? 0, recentMessages: snap.recentMessages ?? [] })}`,
    `ALLOWED_TOOLS (use EXACTLY these names): ${JSON.stringify(catalog)}`,
    `HISTORY_JSON (most recent last): ${JSON.stringify(snap.history)}`,
    "Rules: return ONLY JSON {action: 'tool'|'complete'|'escalate', tool?, args?, reasoning?, reason?}.",
    "Choose a tool only if it can advance the objective given the state above.",
    "Use args fields exactly as listed; never invent emails, prices, times, or facts.",
    "Choose complete when the objective is met or no useful tool remains.",
    "Choose escalate when blocked by policy, missing data, or repeated failure.",
  ].join("\n");
}

// Genuine LLM-driven next-tool selection: native function-calling where the
// provider supports it, validated JSON-mode otherwise. Every returned call is
// validated against the registry (name + args schema) before execution.
export async function decideNextAction(
  snap: StateSnapshot, allowed: string[],
  tracking?: { workspaceId?: string; campaignId?: string; leadId?: string; runId?: string },
  correction?: string,
): Promise<ToolChoice> {
  const { getLLMProvider } = await import("@/lib/llm");
  const { resolveModel } = await import("@/lib/models");
  const mc = await resolveModel("reasoning", tracking?.workspaceId);
  const llm = getLLMProvider(mc.provider);
  let prompt = decisionPrompt(snap, allowed);
  if (correction) {
    prompt += `\nCORRECTION: your previous response was rejected: ${correction}. Fix it and respond with valid JSON only.`;
  }
  const opts = { model: mc.model, temperature: 0, maxTokens: 800, tracking: { ...tracking, task: "reasoning" as const } };
  if (llm.selectTool) {
    const choice = await llm.selectTool({ prompt, tools: toolCatalog(allowed), opts });
    if (choice.action === "tool") validateDecision(choice, allowed); // throws DecisionError on any violation
    return choice;
  }
  const raw = await llm.generateStructured<ToolChoice>(prompt, null, opts);
  if (raw.action === "tool") validateDecision(raw, allowed);
  if (raw.action !== "tool" && raw.action !== "complete" && raw.action !== "escalate") {
    throw new DecisionError(`unknown action ${String((raw as { action?: unknown }).action)}`);
  }
  return raw;
}

// Deterministic fallback used ONLY when no LLM provider is configured
// (dev/test/staging without keys). State-driven, never a blind replay: it picks
// the first permitted tool that has not yet succeeded in this run and whose
// schema the current input satisfies, and stops after errors.
export function fallbackDecide(
  snap: StateSnapshot, allowed: string[], input: Record<string, unknown>,
): ToolChoice {
  const last = snap.history[snap.history.length - 1];
  if (last && !last.ok) return { action: "escalate", reason: `previous tool ${last.tool} failed; no LLM available to replan` };
  const succeeded = new Set(snap.history.filter((h) => h.ok).map((h) => h.tool));
  for (const name of allowed) {
    const tool = tools[name];
    if (!tool || succeeded.has(name)) continue;
    if (tool.schema.safeParse({ ...input }).success) {
      return { action: "tool", tool: name, args: { ...input }, reasoning: "deterministic fallback: first untried applicable tool" };
    }
  }
  return { action: "complete", reason: "no further applicable tools" };
}

async function finishRun(runId: string | null, t0: number, status: "completed" | "needs_review" | "failed", body: Record<string, unknown>, error?: string) {
  if (!runId) return;
  await db.agentRun.update({
    where: { id: runId },
    data: { status, output: J({ ...body, latencyMs: Date.now() - t0 }), latencyMs: Date.now() - t0, ...(error ? { error } : {}) },
  }).catch(() => undefined);
}

// Orchestrator: genuine agent loop — the LLM observes state + history and selects
// each next tool. Safety (budgets, permissions, suppression, idempotency, approval
// gates, claim validation) stays deterministic inside the tools, outside model control.
export async function runAgent(
  type: string, input: Record<string, unknown>, ids: { campaignId?: string; leadId?: string },
  opts?: RunOpts,
) {
  const ctx = newContext(ids.campaignId, ids.leadId);
  const run = await db.agentRun.create({ data: { type, campaignId: ids.campaignId, leadId: ids.leadId, status: "running", input: J(input), correlationId: ctx.correlationId } }).catch(() => null);
  const t0 = Date.now();
  const allowed = ALLOWED_TOOLS[type] ?? [];
  const maxIter = opts?.maxIterations ?? MAX_AGENT_STEPS;
  const history: HistoryEntry[] = [];
  let consecutiveErrors = 0;
  let lastOutput: unknown = null;
  try {
    for (let iter = 1; iter <= maxIter; iter++) {
      ctx.steps++;
      try {
        checkBudgets(ctx);
      } catch (e) {
        await finishRun(run?.id ?? null, t0, "needs_review", { termination: "budget-exhausted", iterations: iter - 1, toolCalls: ctx.toolCalls }, String(e));
        throw e;
      }
      const snap = await buildSnapshot(type, ids, history, iter);
      let decision: ToolChoice;
      try {
        decision = opts?.decide
          ? await opts.decide(snap, allowed)
          : await decideNextAction(snap, allowed, { workspaceId: snap.lead?.workspaceId, campaignId: ids.campaignId, leadId: ids.leadId, runId: run?.id });
      } catch (e) {
        if (e instanceof DecisionError && !opts?.decide) {
          // Genuine recovery: give the model its validation error and one chance
          // to correct. A second failure escalates — never an infinite re-prompt.
          try {
            decision = await decideNextAction(snap, allowed, { workspaceId: snap.lead?.workspaceId, campaignId: ids.campaignId, leadId: ids.leadId, runId: run?.id }, String(e));
          } catch (e2) {
            await finishRun(run?.id ?? null, t0, "needs_review", { termination: "invalid-decision", iterations: iter - 1 }, String(e2));
            throw e2 instanceof DecisionError ? e2 : new DecisionError(String(e2));
          }
        } else if (/LLM not configured|not configured/i.test(String(e))) {
          decision = fallbackDecide(snap, allowed, input);
        } else {
          await finishRun(run?.id ?? null, t0, "failed", { termination: "decision-failed", iterations: iter - 1 }, String(e));
          throw e;
        }
      }
      if (decision!.action === "complete") {
        await finishRun(run?.id ?? null, t0, "completed", { termination: "complete", reason: decision!.reason ?? "", iterations: iter - 1, toolCalls: ctx.toolCalls, lastOutput });
        return lastOutput;
      }
      if (decision!.action === "escalate") {
        await finishRun(run?.id ?? null, t0, "needs_review", { termination: "escalated", reason: decision!.reason ?? "", iterations: iter - 1, toolCalls: ctx.toolCalls });
        return lastOutput;
      }
      // Validate the selected call (applies to LLM AND injected decisions alike).
      let toolName: string;
      let args: Record<string, unknown>;
      let reasoning = "";
      try {
        const v = validateDecision(decision!, allowed);
        toolName = v.tool; args = v.args; reasoning = v.reasoning;
        await enforceToolScope(await runWorkspaceId(ids), toolName, args);
      } catch (e) {
        await finishRun(run?.id ?? null, t0, "needs_review", { termination: "invalid-decision", iterations: iter - 1, error: String(e) }, String(e));
        throw e instanceof DecisionError ? e : new DecisionError(String(e));
      }
      // Loop protection: same tool + identical args already succeeded twice → stop.
      const sameCount = history.filter((h) => {
        if (!h.ok || h.tool !== toolName) return false;
        try {
          return stableArgs(JSON.parse((h as unknown as { rawArgs?: string }).rawArgs ?? "null")) === stableArgs(args);
        } catch {
          return false;
        }
      }).length;
      if (sameCount >= MAX_IDENTICAL_CALLS - 1) {
        await finishRun(run?.id ?? null, t0, "needs_review", { termination: "repeated-action", tool: toolName, iterations: iter - 1 });
        return lastOutput;
      }
      // Skip step persistence when the run row itself could not be created
      // (avoids orphan AgentSteps that violate the run FK and silently drop
      // the tool-call audit trail).
      const step = run
        ? await db.agentStep.create({ data: { runId: run.id, index: iter, action: toolName, detail: J({ reasoning, args }) } }).catch(() => null)
        : null;
      ctx.toolCalls++;
      try {
        checkBudgets(ctx);
      } catch (e) {
        await finishRun(run?.id ?? null, t0, "needs_review", { termination: "budget-exhausted", iterations: iter - 1, toolCalls: ctx.toolCalls }, String(e));
        throw e;
      }
      const callT0 = Date.now();
      try {
        const result = await tools[toolName]!.fn(args, ids);
        lastOutput = result;
        consecutiveErrors = 0;
        history.push({ tool: toolName, ok: true, summary: summarizeResult(result) });
        (history[history.length - 1] as unknown as { rawArgs?: string }).rawArgs = JSON.stringify(args);
        if (step) {
          await db.agentToolCall.create({ data: { stepId: step.id, tool: toolName, args: J(args), result: J(result ?? {}), status: "ok", latencyMs: Date.now() - callT0 } }).catch(() => undefined);
        }
      } catch (e) {
        const err = String(e);
        consecutiveErrors++;
        history.push({ tool: toolName, ok: false, summary: err.slice(0, 500) });
        if (step) {
          await db.agentToolCall.create({ data: { stepId: step.id, tool: toolName, args: J(args), status: "failed", latencyMs: Date.now() - callT0, result: J({ error: err.slice(0, 500) }) } }).catch(() => undefined);
        }
        if (!isRetryableError(e) || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await finishRun(run?.id ?? null, t0, "needs_review", { termination: "policy-blocked", tool: toolName, iterations: iter, error: err.slice(0, 500) }, err);
          return lastOutput;
        }
        // Transient: loop continues; the next decision sees the failure and may retry or pivot.
      }
    }
    await finishRun(run?.id ?? null, t0, "needs_review", { termination: "max-iterations", iterations: maxIter, toolCalls: ctx.toolCalls });
    return lastOutput;
  } catch (e) {
    if (e instanceof BudgetError) {
      await finishRun(run?.id ?? null, t0, "needs_review", { termination: "budget-exhausted", toolCalls: ctx.toolCalls }, String(e));
    } else if (run && (e as Error)?.message !== undefined) {
      const current = await db.agentRun.findUnique({ where: { id: run.id } }).catch(() => null);
      if (current?.status === "running") {
        await finishRun(run.id, t0, "failed", { termination: "error" }, String(e));
      }
    }
    throw e;
  }
}

// Resume a run after worker/process failure: rebuilds history from persisted
// steps + tool calls, then continues the loop without re-executing successes.
export async function resumeRun(runId: string, opts?: RunOpts & { type?: string; input?: Record<string, unknown>; ids?: { campaignId?: string; leadId?: string } }) {
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("run not found");
  if (run.status === "completed") return (run.output as { lastOutput?: unknown } | null)?.lastOutput ?? null;
  const steps = await db.agentStep.findMany({ where: { runId }, orderBy: { index: "asc" }, include: { toolCalls: true } });
  const history: HistoryEntry[] = [];
  for (const s of steps) {
    for (const c of s.toolCalls) {
      const ok = c.status === "ok";
      const entry: HistoryEntry = { tool: c.tool, ok, summary: summarizeResult(c.result) };
      if (ok) (entry as unknown as { rawArgs?: string }).rawArgs = JSON.stringify(c.args);
      history.push(entry);
    }
  }
  return runAgentWithHistory(
    opts?.type ?? run.type,
    (opts?.input ?? run.input ?? {}) as Record<string, unknown>,
    { campaignId: opts?.ids?.campaignId ?? run.campaignId ?? undefined, leadId: opts?.ids?.leadId ?? run.leadId ?? undefined },
    { ...opts, preHistory: history, resumeRunId: runId },
  );
}

async function runAgentWithHistory(
  type: string, input: Record<string, unknown>, ids: { campaignId?: string; leadId?: string },
  opts?: RunOpts & { preHistory?: HistoryEntry[]; resumeRunId?: string },
) {
  // Reuses runAgent's loop by replaying history: temporarily prepend successes
  // as already-executed so repeat/idempotency guards hold, then continue.
  const pre = opts?.preHistory ?? [];
  if (!pre.length || !opts?.resumeRunId) {
    return runAgent(type, input, ids, opts);
  }
  const runId = opts.resumeRunId;
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("run not found");
  await db.agentRun.update({ where: { id: runId }, data: { status: "running", error: null } }).catch(() => undefined);
  const ctx = newContext(ids.campaignId, ids.leadId);
  const t0 = Date.now();
  const allowed = ALLOWED_TOOLS[type] ?? [];
  const maxIter = opts?.maxIterations ?? MAX_AGENT_STEPS;
  const history: HistoryEntry[] = pre.map((h) => ({ ...h }));
  // Re-attach persisted args for repeat detection (history entries built from
  // summaries alone cannot be compared for identical-arg loops).
  const steps = await db.agentStep.findMany({ where: { runId }, orderBy: { index: "asc" }, include: { toolCalls: true } });
  for (const s of steps) {
    for (const c of s.toolCalls) {
      if (c.status !== "ok") continue;
      const h = history.find((x) => x.tool === c.tool && x.ok && !(x as unknown as { rawArgs?: string }).rawArgs);
      if (h) (h as unknown as { rawArgs?: string }).rawArgs = JSON.stringify(c.args);
    }
  }
  let consecutiveErrors = 0;
  let lastOutput: unknown = (run.output as { lastOutput?: unknown } | null)?.lastOutput ?? null;
  const startIndex = steps.length;
  try {
    for (let k = 1; k <= maxIter; k++) {
      const iter = startIndex + k;
      ctx.steps++;
      try {
        checkBudgets(ctx);
      } catch (e) {
        await finishRun(runId, t0, "needs_review", { termination: "budget-exhausted", resumed: true }, String(e));
        throw e;
      }
      const snap = await buildSnapshot(type, ids, history, iter);
      let decision: ToolChoice;
      try {
        decision = opts?.decide
          ? await opts.decide(snap, allowed)
          : await decideNextAction(snap, allowed, { campaignId: ids.campaignId, leadId: ids.leadId, runId });
      } catch (e) {
        if (e instanceof DecisionError && !opts?.decide) {
          try {
            decision = await decideNextAction(snap, allowed, { campaignId: ids.campaignId, leadId: ids.leadId, runId }, String(e));
          } catch (e2) {
            await finishRun(runId, t0, "needs_review", { termination: "invalid-decision", resumed: true }, String(e2));
            throw e2 instanceof DecisionError ? e2 : new DecisionError(String(e2));
          }
        } else if (/LLM not configured|not configured/i.test(String(e))) decision = fallbackDecide(snap, allowed, input);
        else {
          await finishRun(runId, t0, "failed", { termination: "decision-failed", resumed: true }, String(e));
          throw e;
        }
      }
      if (decision!.action === "complete") {
        await finishRun(runId, t0, "completed", { termination: "complete", resumed: true, reason: decision!.reason ?? "", lastOutput });
        return lastOutput;
      }
      if (decision!.action === "escalate") {
        await finishRun(runId, t0, "needs_review", { termination: "escalated", resumed: true, reason: decision!.reason ?? "" });
        return lastOutput;
      }
      let toolName: string;
      let args: Record<string, unknown>;
      try {
        const v = validateDecision(decision!, allowed);
        toolName = v.tool; args = v.args;
        await enforceToolScope(await runWorkspaceId(ids), toolName, args);
      } catch (e) {
        await finishRun(runId, t0, "needs_review", { termination: "invalid-decision", resumed: true }, String(e));
        throw e instanceof DecisionError ? e : new DecisionError(String(e));
      }
      const sameCount = history.filter((h) => {
        if (!h.ok || h.tool !== toolName) return false;
        try {
          return stableArgs(JSON.parse((h as unknown as { rawArgs?: string }).rawArgs ?? "null")) === stableArgs(args);
        } catch {
          return false;
        }
      }).length;
      if (sameCount >= MAX_IDENTICAL_CALLS - 1) {
        await finishRun(runId, t0, "needs_review", { termination: "repeated-action", tool: toolName, resumed: true });
        return lastOutput;
      }
      const step = await db.agentStep.create({ data: { runId, index: iter, action: toolName, detail: J({ args, resumed: true }) } }).catch(() => null);
      ctx.toolCalls++;
      const callT0 = Date.now();
      try {
        const result = await tools[toolName]!.fn(args, ids);
        lastOutput = result;
        consecutiveErrors = 0;
        const entry: HistoryEntry = { tool: toolName, ok: true, summary: summarizeResult(result) };
        (entry as unknown as { rawArgs?: string }).rawArgs = JSON.stringify(args);
        history.push(entry);
        if (step) await db.agentToolCall.create({ data: { stepId: step.id, tool: toolName, args: J(args), result: J(result ?? {}), status: "ok", latencyMs: Date.now() - callT0 } }).catch(() => undefined);
      } catch (e) {
        const err = String(e);
        consecutiveErrors++;
        history.push({ tool: toolName, ok: false, summary: err.slice(0, 500) });
        if (step) await db.agentToolCall.create({ data: { stepId: step.id, tool: toolName, args: J(args), status: "failed", latencyMs: Date.now() - callT0, result: J({ error: err.slice(0, 500) }) } }).catch(() => undefined);
        if (!isRetryableError(e) || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await finishRun(runId, t0, "needs_review", { termination: "policy-blocked", tool: toolName, resumed: true }, err);
          return lastOutput;
        }
      }
    }
    await finishRun(runId, t0, "needs_review", { termination: "max-iterations", resumed: true });
    return lastOutput;
  } catch (e) {
    const current = await db.agentRun.findUnique({ where: { id: runId } }).catch(() => null);
    if (current?.status === "running") await finishRun(runId, t0, "failed", { termination: "error", resumed: true }, String(e));
    throw e;
  }
}
