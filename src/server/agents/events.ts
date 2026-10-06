import { db, J } from "@/lib/db";

// Shared agent event emission: every tool outcome is recorded both as a
// campaign/lead-scoped agent event (activity stream) and as an audit-log row.
// Db failures degrade to silence (preview/unmigrated environments), never to
// a failed tool call.
export async function emit(
  kind: string,
  message: string,
  ids: { leadId?: string; campaignId?: string },
  payload?: unknown,
) {
  try {
    await db.agentEvent.create({ data: { kind, message, ...ids, payload: J(payload ?? {}) } });
    await db.activityLog.create({
      data: { leadId: ids.leadId, campaignId: ids.campaignId, actor: "agent", action: kind, detail: J(payload ?? { message }) },
    });
  } catch { /* db may be unmigrated in preview */ }
}
