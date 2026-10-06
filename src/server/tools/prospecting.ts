import { z } from "zod";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { prospectProvider } from "@/lib/prospect-providers";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const searchProspectsSchema = z.object({ campaignId: z.string() });

export async function searchProspects(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { campaignId } = args as { campaignId: string };
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
        create: { workspaceId: campaign.workspaceId, campaignId: campaign.id, companyId: company.id, contactId: contact.id, status: "NEW", source: provider.name },
      });
      if (!existingContact) {
        created++;
        await emit("lead.discovered", `Lead discovered: ${contact.fullName} @ ${company.name}`, { campaignId, leadId: undefined }, { company: company.name });
      }
    }
  }
  await enqueue("enrichment", { campaignId });
  return { companies: companies.length, leads: created, skippedSuppressed };
}

export const prospectingTools: Record<string, ToolDef> = {
  searchProspects: { schema: searchProspectsSchema, fn: searchProspects, destructive: false },
};
