import { db, J } from "./db";

export const RESEARCH_VERSION = 1; // bump when research logic/sources change (invalidates old cache)
const DEFAULT_TTL_MS = 7 * 86400_000;

export interface CachedResearch {
  hit: boolean;
  payload?: { summary: string; evidence: Array<Record<string, unknown>> };
}

// Workspace-scoped cache key: (workspace, subjectType, subjectKey, researchType, version).
// subjectKey is always lowercased domain/email — no cross-workspace leakage possible
// because workspaceId is part of the unique constraint.
export async function getCachedResearch(
  workspaceId: string, subjectType: "company" | "person",
  subjectKey: string, researchType: string,
): Promise<CachedResearch> {
  try {
    const row = await db.researchCache.findUnique({
      where: {
        workspaceId_subjectType_subjectKey_researchType_version: {
          workspaceId, subjectType, subjectKey: subjectKey.toLowerCase(),
          researchType, version: RESEARCH_VERSION,
        },
      },
    });
    if (row && row.expiresAt > new Date()) {
      await db.researchCache.update({ where: { id: row.id }, data: { hits: { increment: 1 } } }).catch(() => undefined);
      return { hit: true, payload: row.payload as CachedResearch["payload"] };
    }
  } catch { /* cache miss on any failure */ }
  return { hit: false };
}

export async function putCachedResearch(
  workspaceId: string, subjectType: "company" | "person",
  subjectKey: string, researchType: string,
  payload: { summary: string; evidence: Array<Record<string, unknown>> },
  opts?: { ttlMs?: number; provider?: string; sourceHash?: string },
): Promise<void> {
  try {
    await db.researchCache.upsert({
      where: {
        workspaceId_subjectType_subjectKey_researchType_version: {
          workspaceId, subjectType, subjectKey: subjectKey.toLowerCase(),
          researchType, version: RESEARCH_VERSION,
        },
      },
      update: {
        payload: J(payload), expiresAt: new Date(Date.now() + (opts?.ttlMs ?? DEFAULT_TTL_MS)),
        provider: opts?.provider, sourceHash: opts?.sourceHash,
      },
      create: {
        workspaceId, subjectType, subjectKey: subjectKey.toLowerCase(), researchType,
        version: RESEARCH_VERSION, payload: J(payload),
        expiresAt: new Date(Date.now() + (opts?.ttlMs ?? DEFAULT_TTL_MS)),
        provider: opts?.provider, sourceHash: opts?.sourceHash,
      },
    });
  } catch { /* caching must never break research */ }
}

export async function invalidateResearch(workspaceId: string, subjectKey: string): Promise<number> {
  try {
    const r = await db.researchCache.deleteMany({
      where: { workspaceId, subjectKey: subjectKey.toLowerCase() },
    });
    return r.count;
  } catch {
    return 0;
  }
}
