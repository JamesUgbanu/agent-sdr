import { db, J } from "@/lib/db";

// Shared agent event emission: every tool outcome is recorded both as a
// campaign/lead-scoped agent event (activity stream) and as an audit-log row.
// Db failures stay non-fatal (preview/unmigrated environments; an audit failure
// must not destroy an otherwise recoverable run) but are warned — identifiers
// only, never message bodies or payloads, which can contain prospect PII.
export async function emit(
  kind: string,
  message: string,
  ids: { leadId?: string; campaignId?: string; runId?: string },
  payload?: unknown,
) {
  const { runId, leadId, campaignId } = ids;
  try {
    await db.agentEvent.create({ data: { kind, message, leadId, campaignId, ...(runId ? { runId } : {}), payload: J(payload ?? {}) } });
    await db.activityLog.create({
      data: { leadId, campaignId, actor: "agent", action: kind, detail: J(payload ?? { message }) },
    });
  } catch (e) {
    console.warn(`[agent] emit failed (event ${kind}, run ${runId ?? "n/a"}, lead ${leadId ?? "n/a"}): ${String(e).slice(0, 200)}`);
  }
}
