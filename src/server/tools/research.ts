import { z } from "zod";
import { db, J } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { transitionLead, canTransition, setLeadStatus } from "@/lib/state-machine";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const researchCompanySchema = z.object({ leadId: z.string() });

export async function researchCompany(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId } = args as { leadId: string };
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
    // SSRF guard: the domain comes from workspace-supplied company data.
    const { isPublicHostname } = await import("@/lib/ssrf-guard");
    if (!(await isPublicHostname(domain).catch(() => false))) {
      await emit("research.blocked", `Skipped fetch for non-public domain: ${domain}`, { leadId: lead.id, campaignId: lead.campaignId });
    } else try {
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
      await setLeadStatus(lead.id, "RESEARCHING", { note: "research complete" });
    }
  });
  await emit("research.completed", `Researched ${lead.company.name}: ${evidence.length} evidence items`, { leadId: lead.id, campaignId: lead.campaignId });
  await enqueue("qualification", { leadId: lead.id });
  return { summary, evidenceCount: evidence.length, cacheHit };
}

export const researchTools: Record<string, ToolDef> = {
  researchCompany: { schema: researchCompanySchema, fn: researchCompany, destructive: false },
};
