import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { CampaignSchema } from "@/lib/validation";

import { withApi } from "@/lib/api";

async function getHandler(req: Request) {
  const { requireSession } = await import("@/lib/session");
  const { userId } = await requireSession();
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (workspaceId) {
    const { requireMembership } = await import("@/lib/session");
    await requireMembership(workspaceId);
  }
  const mine = await db.workspaceMember.findMany({ where: { userId } });
  const ids = mine.map((m) => m.workspaceId);
  const campaigns = await db.campaign.findMany({
    where: { workspaceId: workspaceId ?? { in: ids } },
    orderBy: { createdAt: "desc" }, take: 50,
  });
  return NextResponse.json(campaigns);
}
async function postHandler(req: Request) {
  const body = await req.json();
  const parsed = CampaignSchema.extend({ workspaceId: z.string() }).parse(body);
  const { requireMembership } = await import("@/lib/session");
  await requireMembership(parsed.workspaceId);
  const campaign = await db.campaign.create({
    data: {
      workspaceId: parsed.workspaceId, name: parsed.name, description: parsed.description,
      targetGeography: parsed.targetGeography, targetIndustries: parsed.targetIndustries,
      companySizeMin: parsed.companySizeMin, companySizeMax: parsed.companySizeMax,
      jobTitles: parsed.jobTitles, technologies: parsed.technologies,
      offer: parsed.offer, valueProposition: parsed.valueProposition,
      channels: parsed.channels, approvalPolicy: parsed.approvalPolicy,
      dailySendLimit: parsed.dailySendLimit, timezone: parsed.timezone,
      minScoreToContact: parsed.minScoreToContact, status: "active",
    },
  });
  await db.sequence.create({
    data: {
      campaignId: campaign.id, name: "Default 4-step",
      steps: { create: [
        { order: 0, dayOffset: 0, subjectTemplate: "Idea for {{company}}", bodyTemplate: "Step 0", channel: "email" },
        { order: 1, dayOffset: 3, subjectTemplate: "Re: Idea", bodyTemplate: "Follow-up 1", channel: "email" },
        { order: 2, dayOffset: 7, subjectTemplate: "Re: Idea", bodyTemplate: "Follow-up 2", channel: "email" },
        { order: 3, dayOffset: 14, subjectTemplate: "Closing the loop", bodyTemplate: "Breakup", channel: "email" },
      ]},
    },
  });
  const { enqueue } = await import("@/lib/queue");
  await enqueue("prospecting", { campaignId: campaign.id });
  return NextResponse.json(campaign, { status: 201 });
}

export const GET = withApi(getHandler);
export const POST = withApi(postHandler);
