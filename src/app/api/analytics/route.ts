import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { db } from "@/lib/db";
import { withApi } from "@/lib/api";

async function getHandler(req: Request) {
  const { requireSession, requireMembership } = await import("@/lib/session");
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const campaignId = searchParams.get("campaignId");
  let workspaceIds: string[] | null = null;
  let campaignIds: string[] | null = null;
  if (campaignId) {
    const camp = await db.campaign.findUnique({ where: { id: campaignId } }).catch(() => null);
    if (camp) await requireMembership(camp.workspaceId);
  } else {
    // No campaign filter: scope every metric to the caller's workspaces.
    // An authenticated user with no memberships sees zeros, never other tenants' data.
    const members = await db.workspaceMember.findMany({ where: { userId } });
    workspaceIds = members.map((m) => m.workspaceId);
    const camps = await db.campaign.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true } });
    campaignIds = camps.map((c) => c.id);
  }
  const campFilter = campaignId ? { campaignId } : { campaignId: { in: campaignIds ?? [] } };
  const wsFilter = campaignId ? undefined : { in: workspaceIds ?? [] };
  const leadScope = { thread: { lead: campaignId ? { campaignId } : { workspaceId: wsFilter } } };
  try {
    const leadIds = campaignId
      ? undefined
      : (await db.lead.findMany({ where: { campaignId: { in: campaignIds ?? [] } }, select: { id: true } })).map((l) => l.id);
    // Lead-source funnel: source → qualified → contacted → replied → meeting.
    const funnelRows = await db.lead.groupBy({
      by: ["source", "status"],
      where: campFilter,
      _count: { _all: true },
    }).catch(() => []);
    const funnel: Record<string, { total: number; qualified: number; contacted: number; replied: number; meetings: number }> = {};
    for (const r of funnelRows) {
      const src = r.source ?? "unknown";
      funnel[src] ??= { total: 0, qualified: 0, contacted: 0, replied: 0, meetings: 0 };
      funnel[src]!.total += r._count._all;
      if (["QUALIFIED", "READY_FOR_OUTREACH", "CONTACTED", "FOLLOW_UP", "REPLIED", "QUALIFIED_REPLY", "MEETING_REQUESTED", "MEETING_BOOKED"].includes(r.status)) funnel[src]!.qualified += r._count._all;
      if (["CONTACTED", "FOLLOW_UP", "REPLIED", "QUALIFIED_REPLY", "MEETING_REQUESTED", "MEETING_BOOKED"].includes(r.status)) funnel[src]!.contacted += r._count._all;
      if (["REPLIED", "QUALIFIED_REPLY", "MEETING_REQUESTED", "MEETING_BOOKED"].includes(r.status)) funnel[src]!.replied += r._count._all;
      if (r.status === "MEETING_BOOKED") funnel[src]!.meetings += r._count._all;
    }
    const [
      prospects, qualified, sent, delivered, bounced, failed,
      replies, positive, negative, meetings, completions, stops, optouts,
      runs, llmCalls, tokens, cost, cacheHits,
    ] = await Promise.all([
      db.lead.count({ where: campFilter }),
      db.lead.count({ where: { ...campFilter, score: { gte: 60 } } }),
      db.message.count({ where: { status: { in: ["sent", "delivered"] }, ...leadScope } }),
      db.message.count({ where: { status: "delivered", ...leadScope } }),
      db.message.count({ where: { status: "bounced", ...leadScope } }),
      db.message.count({ where: { status: "failed", ...leadScope } }),
      db.message.count({ where: { direction: "inbound", ...leadScope } }),
      db.message.count({ where: { direction: "inbound", classification: { in: ["interested", "meeting_request"] }, ...leadScope } }),
      db.message.count({ where: { direction: "inbound", classification: { in: ["not_interested", "unsubscribe"] }, ...leadScope } }),
      db.meeting.count({ where: { status: "scheduled", lead: campaignId ? { campaignId } : { workspaceId: wsFilter } } }),
      db.lead.count({ where: { ...campFilter, status: "MEETING_BOOKED" } }),
      db.leadSequenceState.count({ where: { stoppedReason: { not: null }, lead: campaignId ? { campaignId } : { workspaceId: wsFilter } } }),
      db.suppression.count({ where: campaignId
        ? { workspace: { campaigns: { some: { id: campaignId } } } }
        : { workspaceId: wsFilter } }),
      db.agentRun.count({ where: campaignId ? { campaignId } : { OR: [{ campaignId: { in: campaignIds ?? [] } }, { leadId: { in: leadIds ?? [] } }] } }),
      db.llmUsage.count({ where: campaignId ? { campaignId } : { workspaceId: wsFilter } }),
      db.llmUsage.aggregate({ where: campaignId ? { campaignId } : { workspaceId: wsFilter }, _sum: { totalTokens: true, costUsd: true } }),
      db.llmUsage.aggregate({ where: campaignId ? { campaignId } : { workspaceId: wsFilter }, _sum: { costUsd: true } }),
      db.researchCache.aggregate({ where: campaignId ? {} : { workspaceId: wsFilter }, _sum: { hits: true } }),
    ]);
    // Operational warnings (not vanity metrics): surface unsafe/failing states.
    const warnings: string[] = [];
    if (sent > 0 && bounced / sent >= 0.05) warnings.push(`bounce rate ${(bounced / sent * 100).toFixed(1)}% ≥ 5% — pause sending and clean the list`);
    if (failed > 0) warnings.push(`${failed} failed send(s) — check provider credentials and dead letters`);
    if (optouts > 0 && sent > 0 && optouts / sent >= 0.02) warnings.push(`opt-out rate ${(optouts / sent * 100).toFixed(1)}% ≥ 2% — review messaging and targeting`);
    if (prospects > 0 && qualified === 0) warnings.push("no qualified leads — review ICP fit or scoring weights");
    return NextResponse.json({
      prospectsDiscovered: prospects, prospectsQualified: qualified,
      emailsSent: sent, delivered, bounced, failedSends: failed,
      replied: replies, positiveReplies: positive, negativeReplies: negative,
      meetingsBooked: meetings, sequenceCompletions: completions, sequenceStops: stops,
      optOuts: optouts, aiRuns: runs, llmCalls,
      tokens: tokens._sum.totalTokens ?? 0, estimatedCostUsd: cost._sum.costUsd ?? 0,
      researchCacheHits: cacheHits._sum.hits ?? 0,
      sourceBreakdown: funnel,
      warnings,
    });
  } catch {
    return NextResponse.json({ offline: true });
  }
}

export const GET = withApi(getHandler);
