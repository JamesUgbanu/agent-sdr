import type {
  CompanySearchInput, CompanyResult, ContactSearchInput, ContactResult,
  EmailVerificationProvider, ProspectProvider, VerificationResult,
} from "./providers";
import { InternalSeedProvider } from "./providers";

// Apollo adapter — real HTTP behind the ProspectProvider boundary.
// Requires APOLLO_API_KEY; throws a clear error otherwise (never fakes results).
export class ApolloProvider implements ProspectProvider {
  name = "apollo";
  constructor(private apiKey = process.env.APOLLO_API_KEY ?? "") {}
  private guard() {
    if (!this.apiKey) throw new Error("APOLLO_API_KEY not configured — connect Apollo in Settings");
  }
  async searchCompanies(input: CompanySearchInput): Promise<CompanyResult[]> {
    this.guard();
    const r = await fetch("https://api.apollo.io/v1/mixed_companies/search", {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q_organization_name: input.query, page: 1, per_page: input.limit ?? 10 }),
    });
    if (!r.ok) throw new Error(`apollo companies: ${r.status}`);
    const j = (await r.json()) as { organizations?: Array<Record<string, string | number>> };
    return (j.organizations ?? []).map((o) => ({
      name: String(o.name ?? ""), domain: o.website_url ? String(o.website_url) : undefined,
      industry: o.industry ? String(o.industry) : undefined,
      employeeCount: Number(o.estimated_num_employees ?? 0) || undefined,
      location: o.country ? String(o.country) : undefined,
    }));
  }
  async searchContacts(input: ContactSearchInput): Promise<ContactResult[]> {
    this.guard();
    const r = await fetch("https://api.apollo.io/v1/mixed_people/search", {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q_organization_domains: input.companyDomain ? [input.companyDomain] : [], person_titles: input.titles, page: 1, per_page: input.limit ?? 10 }),
    });
    if (!r.ok) throw new Error(`apollo people: ${r.status}`);
    const j = (await r.json()) as { people?: Array<Record<string, string>> };
    return (j.people ?? []).map((p) => ({
      firstName: p.first_name, lastName: p.last_name, title: p.title,
      email: p.email, linkedinUrl: p.linkedin_url,
    }));
  }
}

// Hunter.io: domain search + email finder + verifier (real REST; key required).
export class HunterProvider implements ProspectProvider, EmailVerificationProvider {
  name = "hunter";
  constructor(private apiKey = process.env.HUNTER_API_KEY ?? "") {}
  private guard() {
    if (!this.apiKey) throw new Error("HUNTER_API_KEY not configured");
  }
  async searchCompanies(_input: CompanySearchInput): Promise<CompanyResult[]> {
    // Hunter is people-centric; company search is not its API — return empty honestly.
    return [];
  }
  async searchContacts(input: ContactSearchInput): Promise<ContactResult[]> {
    this.guard();
    if (!input.companyDomain) return [];
    const r = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(input.companyDomain)}&api_key=${this.apiKey}&limit=${input.limit ?? 10}`,
    );
    if (!r.ok) throw new Error(`hunter: ${r.status}`);
    const j = (await r.json()) as { data?: { emails?: Array<{ first_name?: string; last_name?: string; position?: string; value?: string; confidence?: number; linkedin?: string }> } };
    return (j.data?.emails ?? []).map((e) => ({
      firstName: e.first_name, lastName: e.last_name, title: e.position,
      email: e.value,
      emailConfidence: (e.confidence ?? 0) >= 90 ? "high" : (e.confidence ?? 0) >= 70 ? "medium" : "low",
      linkedinUrl: e.linkedin,
    }));
  }
  async verify(email: string): Promise<VerificationResult> {
    if (!this.apiKey) {
      return { status: "unavailable", confidence: null, provider: this.name, checkedAt: new Date().toISOString() };
    }
    const r = await fetch(
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${this.apiKey}`,
    );
    if (!r.ok) throw new Error(`hunter verify: ${r.status}`);
    const j = (await r.json()) as { data?: { status?: string; score?: number } };
    const map: Record<string, VerificationResult["status"]> = {
      valid: "deliverable", accept_all: "risky", disposable: "risky",
      invalid: "undeliverable", unknown: "unknown",
    };
    const status = map[j.data?.status ?? ""] ?? "unknown";
    return {
      status, confidence: (j.data?.score ?? 0) / 100, provider: this.name,
      evidence: { raw: j.data?.status }, checkedAt: new Date().toISOString(),
    };
  }
}

// People Data Labs: person + company enrichment (real REST; key required).
export class PeopleDataLabsProvider implements ProspectProvider {
  name = "pdl";
  constructor(private apiKey = process.env.PDL_API_KEY ?? "") {}
  private guard() {
    if (!this.apiKey) throw new Error("PDL_API_KEY not configured");
  }
  async searchCompanies(input: CompanySearchInput): Promise<CompanyResult[]> {
    this.guard();
    const r = await fetch("https://api.peopledatalabs.com/v5/company/search", {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: { bool: { must: [{ term: { industry: input.industries?.[0] } }, { term: { location_country: "united states" } }].filter((t) => Object.values(t.term)[0]) } },
        size: input.limit ?? 10,
      }),
    });
    if (!r.ok) throw new Error(`pdl companies: ${r.status}`);
    const j = (await r.json()) as { data?: Array<Record<string, string | number | string[]>> };
    return (j.data ?? []).map((o) => ({
      name: String(o.display_name ?? o.name ?? ""),
      domain: typeof o.website === "string" ? o.website : undefined,
      industry: typeof o.industry === "string" ? o.industry : undefined,
      employeeCount: typeof o.employee_count === "number" ? o.employee_count : undefined,
      location: typeof o.location_name === "string" ? o.location_name : undefined,
    }));
  }
  async searchContacts(input: ContactSearchInput): Promise<ContactResult[]> {
    this.guard();
    const r = await fetch("https://api.peopledatalabs.com/v5/person/search", {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: {
          bool: {
            must: [
              ...(input.companyDomain ? [{ term: { "job_company_website": input.companyDomain } }] : []),
              ...(input.titles?.length ? [{ terms: { job_title: input.titles } }] : []),
            ],
          },
        },
        size: input.limit ?? 10,
      }),
    });
    if (!r.ok) throw new Error(`pdl people: ${r.status}`);
    const j = (await r.json()) as { data?: Array<Record<string, string>> };
    return (j.data ?? []).map((p) => ({
      firstName: p.first_name, lastName: p.last_name, title: p.job_title,
      emailConfidence: "unknown", linkedinUrl: p.linkedin_url,
    }));
  }
}

// Factory: workspace env selects provider; seed provider only for dev/tests.
export function prospectProvider(kind?: string): ProspectProvider {
  const k = kind ?? process.env.PROSPECT_PROVIDER ?? "seed";
  if (k === "apollo") return new ApolloProvider();
  if (k === "hunter") return new HunterProvider();
  if (k === "pdl") return new PeopleDataLabsProvider();
  return new InternalSeedProvider();
}
