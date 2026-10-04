export const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS ?? 20);
export const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS ?? 30);
export const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS ?? 300_000);
// Same tool + identical args succeeding this many times → stop (loop protection).
export const MAX_IDENTICAL_CALLS = 3;
// Consecutive tool errors before the run is escalated instead of continued.
export const MAX_CONSECUTIVE_ERRORS = 3;

export interface AgentContext {
  campaignId?: string;
  leadId?: string;
  correlationId: string;
  startedAt: number;
  steps: number;
  toolCalls: number;
}

export function newContext(campaignId?: string, leadId?: string): AgentContext {
  return {
    campaignId, leadId,
    correlationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(), steps: 0, toolCalls: 0,
  };
}

export function checkBudgets(ctx: AgentContext) {
  if (ctx.steps >= MAX_AGENT_STEPS) throw new BudgetError("max-steps exceeded → NEEDS_REVIEW");
  if (ctx.toolCalls >= MAX_TOOL_CALLS) throw new BudgetError("max-tool-calls exceeded → NEEDS_REVIEW");
  if (Date.now() - ctx.startedAt > MAX_RUNTIME_MS) throw new BudgetError("max-runtime exceeded → NEEDS_REVIEW");
}
export class BudgetError extends Error {}
