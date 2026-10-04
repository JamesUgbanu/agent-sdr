import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";

const DEMO_EMAIL = "demo@agent-sdr.local";
const DEMO_PASSWORD = "demo-password-123";
const DEMO_WORKSPACE_ID = "demo-ws";

async function seedDemoWorkspace() {
  const ws = await db.workspace.upsert({
    where: { id: DEMO_WORKSPACE_ID },
    update: {},
    create: { id: DEMO_WORKSPACE_ID, name: "Demo workspace" },
  });
  return ws;
}

async function seedDemoUser() {
  const existing = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) return existing;
  return db.user.create({
    data: {
      email: DEMO_EMAIL,
      name: "Demo User",
      passwordHash: hashPassword(DEMO_PASSWORD),
    },
  });
}

async function seedDemoMembership(userId: string) {
  const existing = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: DEMO_WORKSPACE_ID, userId } },
  });
  if (existing) return existing;
  return db.workspaceMember.create({
    data: { workspaceId: DEMO_WORKSPACE_ID, userId, role: "owner" },
  });
}

async function seedDemoCampaign(workspaceId: string) {
  const existing = await db.campaign.findFirst({
    where: { workspaceId, name: "Demo: US SaaS CTO Outreach" },
  });
  if (existing) return existing;
  return db.campaign.create({
    data: {
      workspaceId,
      name: "Demo: US SaaS CTO Outreach",
      description: "Sample campaign for local development and testing",
      status: "active",
      targetIndustries: ["SaaS"],
      targetGeography: "United States",
      companySizeMin: 20,
      companySizeMax: 200,
      jobTitles: ["CTO", "VP Engineering"],
      offer: "AI automation implementation",
      valueProposition: "Cut manual ops work by 50%",
      approvalPolicy: "assisted",
      dailySendLimit: 50,
      timezone: "UTC",
      minScoreToContact: 60,
    },
  });
}

async function seedDemoLeads(workspaceId: string, campaignId: string) {
  const count = await db.lead.count({ where: { campaignId } });
  if (count > 0) return;
  const companies: Array<{ name: string; domain: string; industry: string; employeeCount: number; location: string }> = [
    { name: "Acme Corp", domain: "acme.example.com", industry: "SaaS", employeeCount: 120, location: "United States" },
    { name: "Globex Inc", domain: "globex.example.com", industry: "SaaS", employeeCount: 85, location: "United States" },
    { name: "Initech LLC", domain: "initech.example.com", industry: "SaaS", employeeCount: 200, location: "United States" },
  ];
  const contacts = [
    { firstName: "Sarah", lastName: "Chen", title: "CTO", email: "sarah@acme.example.com" },
    { firstName: "James", lastName: "Wilson", title: "VP Engineering", email: "james@globex.example.com" },
    { firstName: "Priya", lastName: "Patel", title: "CTO", email: "priya@initech.example.com" },
  ];
  const statuses = ["READY_FOR_OUTREACH", "CONTACTED", "QUALIFIED"];
  for (const company of companies) {
    const co = await db.company.create({ data: { workspaceId, ...company } });
    const contact = contacts[companies.indexOf(company)]!;
    const ct = await db.contact.create({
      data: { workspaceId, companyId: co.id, ...contact, emailConfidence: "high" },
    });
    await db.lead.create({
      data: {
        workspaceId,
        campaignId,
        companyId: co.id,
        contactId: ct.id,
        status: statuses[companies.indexOf(company)]!,
        score: 70 + companies.indexOf(company) * 5,
      },
    });
  }
}

async function main() {
  const ws = await seedDemoWorkspace();
  console.log("workspace:", ws.id);

  if (process.env.SEED_DEMO_USER === "true") {
    const user = await seedDemoUser();
    console.log("demo user:", user.email);
    await seedDemoMembership(user.id);
    const campaign = await seedDemoCampaign(ws.id);
    console.log("demo campaign:", campaign.id);
    await seedDemoLeads(ws.id, campaign.id);
    console.log("demo leads created");
  } else {
    console.log("SEED_DEMO_USER not enabled — skipping demo user");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
