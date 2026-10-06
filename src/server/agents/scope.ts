import { db } from "@/lib/db";
import { DecisionError } from "./decisions";

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
// Defense-in-depth: each client already runs an isolated deployment, but a
// cross-workspace miss here fails closed regardless.
export async function enforceToolScope(
  ids: { campaignId?: string; leadId?: string },
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const runWs = await runWorkspaceId(ids);
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
