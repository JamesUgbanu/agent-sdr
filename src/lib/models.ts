import { db, J } from "./db";

export type ModelTask =
  | "research" | "scoring" | "personalization" | "reply"
  | "conversation" | "classification" | "enrichment" | "reasoning";

export interface ResolvedModel {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  promptVersion?: string;
  configId?: string;
}

// Explicitly labeled per-1k-token price estimates (USD). Used ONLY when flagged
// costEstimated=true. Real provider-reported usage is stored with exact nulls otherwise.
const PRICE_PER_1K: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  "gpt-4o": { in: 0.0025, out: 0.01 },
  "claude-3-5-sonnet": { in: 0.003, out: 0.015 },
  "deepseek-chat": { in: 0.00027, out: 0.0011 },
  "deepseek-reasoner": { in: 0.00055, out: 0.00219 },
};

const ENV_FALLBACK: Record<string, string> = {
  personalization: process.env.LLM_STRONG_MODEL ?? "gpt-4o",
  reasoning: process.env.LLM_STRONG_MODEL ?? "gpt-4o",
  conversation: process.env.LLM_STRONG_MODEL ?? "gpt-4o",
};

export async function resolveModel(task: ModelTask, workspaceId?: string): Promise<ResolvedModel> {
  try {
    const rows = await db.modelConfig.findMany({
      where: {
        task, enabled: true,
        OR: workspaceId ? [{ workspaceId }, { workspaceId: null }] : [{ workspaceId: null }],
      },
      orderBy: [{ priority: "desc" }, { workspaceId: { sort: "desc", nulls: "last" } }],
      take: 1,
    });
    const c = rows[0];
    if (c) {
      return {
        provider: c.provider, model: c.model, temperature: c.temperature,
        maxTokens: c.maxTokens, configId: c.id,
      };
    }
  } catch { /* db offline → safe fallback below */ }
  const fallback = process.env.LLM_DEFAULT_MODEL ?? "gpt-4o-mini";
  return {
    provider: process.env.LLM_PROVIDER ?? "openai",
    model: ENV_FALLBACK[task] ?? fallback,
    temperature: 0.2, maxTokens: 2000,
  };
}
export interface UsageRecord {
  workspaceId?: string; campaignId?: string; leadId?: string; runId?: string;
  provider: string; model: string; task: string; promptVersion?: string;
  inputTokens: number | null; outputTokens: number | null;
  latencyMs: number; success: boolean; error?: string;
}

export function estimateCost(model: string, input: number | null, output: number | null): { cost: number | null; estimated: boolean } {
  const p = PRICE_PER_1K[model];
  if (!p || input == null || output == null) return { cost: null, estimated: false };
  return { cost: (input * p.in + output * p.out) / 1000, estimated: true };
}

export async function trackUsage(u: UsageRecord): Promise<void> {
  const total = u.inputTokens != null && u.outputTokens != null ? u.inputTokens + u.outputTokens : null;
  const { cost, estimated } = estimateCost(u.model, u.inputTokens, u.outputTokens);
  try {
    await db.llmUsage.create({
      data: {
        workspaceId: u.workspaceId, campaignId: u.campaignId, leadId: u.leadId, runId: u.runId,
        provider: u.provider, model: u.model, task: u.task, promptVersion: u.promptVersion,
        inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: total,
        costUsd: cost, costEstimated: estimated, latencyMs: u.latencyMs,
        success: u.success, error: u.error,
      },
    });
    if (u.runId) {
      await db.agentRun.update({
        where: { id: u.runId },
        data: {
          tokens: { increment: total ?? 0 },
          costUsd: { increment: cost ?? 0 },
          model: u.model,
        },
      }).catch(() => undefined);
    }
      if (total != null) {
        await db.usageEvent.create({
          data: {
            workspaceId: u.workspaceId, campaignId: u.campaignId, leadId: u.leadId,
            kind: "llm_tokens", quantity: total, costUsd: cost ?? 0,
            meta: J({ model: u.model, task: u.task, estimated }),
          },
        }).catch(() => undefined);
      }
    } catch (e) {
      // Observability must never break the agent path — but a lost usage row
      // silently skews cost/analytics, so warn with identifiers only.
      console.warn(`[agent] usage persist failed (run ${u.runId ?? "n/a"}, task ${u.task}): ${String(e).slice(0, 200)}`);
    }
}
