import { db, J } from "@/lib/db";
import { isRetryableError } from "@/lib/queue";
import { checkBudgets, newContext, BudgetError, MAX_IDENTICAL_CALLS, MAX_CONSECUTIVE_ERRORS, MAX_AGENT_STEPS } from "@/lib/budgets";
import type { AgentContext } from "@/lib/budgets";
import { stableArgs } from "@/lib/tool-schema";
import type { ToolChoice } from "@/lib/llm";
import { tools, ALLOWED_TOOLS } from "../tools/registry";
import { buildSnapshot, summarizeResult } from "./state";
import type { HistoryEntry, StateSnapshot, DecideFn, RunOpts } from "./state";
import { DecisionError, decideNextAction, fallbackDecide, validateDecision } from "./decisions";
import { enforceToolScope } from "./scope";
import { emit } from "./events";

// Compatibility re-exports: workers, tests, and staging scripts keep importing
// the agent's public surface from the orchestrator. Implementations live in
// agents/state.ts, agents/decisions.ts, agents/scope.ts, and tools/*.
export { tools };
export type { ToolFn, ToolContext, ToolDef } from "../tools/registry";
export type { HistoryEntry, StateSnapshot, DecideFn, RunOpts } from "./state";
export { DecisionError, decideNextAction, fallbackDecide } from "./decisions";
export { buildSnapshot } from "./state";

async function finishRun(runId: string | null, t0: number, status: "completed" | "needs_review" | "failed", body: Record<string, unknown>, error?: string) {
  if (!runId) return;
  await db.agentRun.update({
    where: { id: runId },
    data: { status, output: J({ ...body, latencyMs: Date.now() - t0 }), latencyMs: Date.now() - t0, ...(error ? { error } : {}) },
  }).catch((e) => {
    // Non-fatal by design (a lost terminal write must not destroy an otherwise
    // recoverable run), but never silent: without this warning a run can sit
    // in "running" with no trace of its outcome.
    console.warn(`[agent] finishRun persist failed (run ${runId}, status ${status}): ${String(e).slice(0, 200)}`);
  });
}

// Loop protection: history holds only already-executed successful calls, so
// the current call is blocked once MAX_IDENTICAL_CALLS - 1 identical successes
// exist (i.e. the MAX_IDENTICAL_CALLS-th identical call never executes).
export function isRepeatedCall(history: HistoryEntry[], toolName: string, args: Record<string, unknown>): boolean {
  const sameCount = history.filter((h) => {
    if (!h.ok || h.tool !== toolName) return false;
    try {
      return stableArgs(JSON.parse((h as unknown as { rawArgs?: string }).rawArgs ?? "null")) === stableArgs(args);
    } catch {
      return false;
    }
  }).length;
  return sameCount >= MAX_IDENTICAL_CALLS - 1;
}

// Orchestrator: genuine agent loop — the LLM observes state + history and selects
// each next tool. Safety (budgets, permissions, suppression, idempotency, approval
// gates, claim validation) stays deterministic inside the tools, outside model control.
//
// snapshot
//   ↓
// decide next action
//   ↓
// validate decision
//   ↓
// enforce permissions/scope
//   ↓
// execute registered tool
//   ↓
// persist result/state
//   ↓
// emit events
//   ↓
// repeat
//
// Shared by fresh runs and resumed runs. The `resumed` flag preserves the exact
// historical behavior of each path (run-row handling, decide tracking, step
// detail shape, budget re-check, finishRun bodies) — see resumeRun below.
async function executeLoop(
  type: string, input: Record<string, unknown>, ids: { campaignId?: string; leadId?: string },
  opts: RunOpts & { ctx: AgentContext; runId: string | null; history: HistoryEntry[]; startIndex: number; resumed: boolean; lastOutput: unknown },
) {
  const { runId, resumed, ctx } = opts;
  const t0 = Date.now();
  const allowed = ALLOWED_TOOLS[type] ?? [];
  const maxIter = opts?.maxIterations ?? MAX_AGENT_STEPS;
  const history: HistoryEntry[] = opts.history;
  let consecutiveErrors = 0;
  let lastOutput: unknown = opts.lastOutput;
  let fallbackEngaged = false;
  // Every terminal write flows through here so the fallback marker (Fix 2)
  // cannot be dropped by a future termination site.
  const finalize = (status: "completed" | "needs_review" | "failed", body: Record<string, unknown>, error?: string) =>
    finishRun(runId, t0, status, { ...body, ...(fallbackEngaged ? { fallback: true } : {}) }, error);
  try {
    for (let k = 1; k <= maxIter; k++) {
      const iter = opts.startIndex + k;
      ctx.steps++;
      try {
        checkBudgets(ctx);
      } catch (e) {
        await finalize("needs_review", { termination: "budget-exhausted", ...(resumed ? { resumed: true } : { iterations: iter - 1, toolCalls: ctx.toolCalls }) }, String(e));
        throw e;
      }
      const snap = await buildSnapshot(type, ids, history, iter);
      let decision: ToolChoice;
      try {
        const { withToolTimeout } = await import("@/lib/tool-timeout");
        // Workspace routing is identical on fresh and resumed runs: a crash
        // must not silently switch model configuration mid-run.
        const tracking = { workspaceId: snap.lead?.workspaceId, campaignId: ids.campaignId, leadId: ids.leadId, runId: runId ?? undefined };
        const decide =
          opts?.decide ??
          ((s: StateSnapshot, a: string[]) => decideNextAction(s, a, tracking));
        decision = await withToolTimeout("decideNextAction", () => decide(snap, allowed));
      } catch (e) {
        if (e instanceof DecisionError && !opts?.decide) {
          // Genuine recovery: give the model its validation error and one chance
          // to correct. A second failure escalates — never an infinite re-prompt.
          try {
            const { withToolTimeout } = await import("@/lib/tool-timeout");
            const tracking = { workspaceId: snap.lead?.workspaceId, campaignId: ids.campaignId, leadId: ids.leadId, runId: runId ?? undefined };
            decision = await withToolTimeout("decideNextAction", () =>
              decideNextAction(snap, allowed, tracking, String(e)));
          } catch (e2) {
            await finalize("needs_review", { termination: "invalid-decision", ...(resumed ? { resumed: true } : { iterations: iter - 1 }) }, String(e2));
            throw e2 instanceof DecisionError ? e2 : new DecisionError(String(e2));
          }
        } else if (/LLM not configured|not configured/i.test(String(e))) {
          // Observable degraded mode: fallback stays fully validated and
          // scope-enforced below, but its engagement must be auditable —
          // otherwise a missing API key silently masquerades as normal
          // LLM-driven completion. The raw error is deliberately NOT stored:
          // provider errors can echo prompt fragments containing prospect PII.
          fallbackEngaged = true;
          await emit("decision.fallback", "LLM unavailable — deterministic fallback engaged", { leadId: ids.leadId, campaignId: ids.campaignId, runId: runId ?? undefined }, { fallback: true, runType: type, iteration: iter });
          decision = fallbackDecide(snap, allowed, input);
        } else {
          await finalize("failed", { termination: "decision-failed", ...(resumed ? { resumed: true } : { iterations: iter - 1 }) }, String(e));
          throw e;
        }
      }
      if (decision!.action === "complete") {
        await finalize("completed", { termination: "complete", reason: decision!.reason ?? "", lastOutput, ...(resumed ? { resumed: true } : { iterations: iter - 1, toolCalls: ctx.toolCalls }) });
        return lastOutput;
      }
      if (decision!.action === "escalate") {
        await finalize("needs_review", { termination: "escalated", reason: decision!.reason ?? "", ...(resumed ? { resumed: true } : { iterations: iter - 1, toolCalls: ctx.toolCalls }) });
        return lastOutput;
      }
      // Validate the selected call (applies to LLM AND injected decisions alike).
      let toolName: string;
      let args: Record<string, unknown>;
      let reasoning = "";
      try {
        const v = validateDecision(decision!, allowed);
        toolName = v.tool; args = v.args; reasoning = v.reasoning;
        await enforceToolScope(ids, toolName, args);
      } catch (e) {
        await finalize("needs_review", { termination: "invalid-decision", ...(resumed ? { resumed: true } : { iterations: iter - 1, error: String(e) }) }, String(e));
        throw e instanceof DecisionError ? e : new DecisionError(String(e));
      }
      // Loop protection: same tool + identical args already succeeded twice → stop.
      if (isRepeatedCall(history, toolName, args)) {
        await finalize("needs_review", { termination: "repeated-action", tool: toolName, ...(resumed ? { resumed: true } : { iterations: iter - 1 }) });
        return lastOutput;
      }
      // Skip step persistence when the run row itself could not be created
      // (avoids orphan AgentSteps that violate the run FK and silently drop
      // the tool-call audit trail). A failed write is non-fatal but warned:
      // the tool still executes, while the missing row stays visible in logs.
      const step = runId
        ? await db.agentStep.create({ data: { runId, index: iter, action: toolName, detail: resumed ? J({ args, resumed: true }) : J({ reasoning, args }) } }).catch((e) => {
            console.warn(`[agent] AgentStep persist failed (run ${runId}, index ${iter}, tool ${toolName}): ${String(e).slice(0, 200)}`);
            return null;
          })
        : null;
      ctx.toolCalls++;
      // Post-increment budget check applies identically to fresh and resumed
      // runs: without it a resumed run could execute one tool past the budget.
      try {
        checkBudgets(ctx);
      } catch (e) {
        await finalize("needs_review", { termination: "budget-exhausted", ...(resumed ? { resumed: true } : { iterations: iter - 1, toolCalls: ctx.toolCalls }) }, String(e));
        throw e;
      }
      const callT0 = Date.now();
      try {
        const { withToolTimeout } = await import("@/lib/tool-timeout");
        const result = await withToolTimeout(toolName, () => tools[toolName]!.fn(args, ids));
        lastOutput = result;
        consecutiveErrors = 0;
        history.push({ tool: toolName, ok: true, summary: summarizeResult(result) });
        (history[history.length - 1] as unknown as { rawArgs?: string }).rawArgs = JSON.stringify(args);
        if (step) {
          await db.agentToolCall.create({ data: { stepId: step.id, tool: toolName, args: J(args), result: J(result ?? {}), status: "ok", latencyMs: Date.now() - callT0 } }).catch((e) => {
            console.warn(`[agent] AgentToolCall persist failed (run ${runId}, step ${step.id}, tool ${toolName}): ${String(e).slice(0, 200)}`);
          });
        }
      } catch (e) {
        const err = String(e);
        consecutiveErrors++;
        history.push({ tool: toolName, ok: false, summary: err.slice(0, 500) });
        if (step) {
          await db.agentToolCall.create({ data: { stepId: step.id, tool: toolName, args: J(args), status: "failed", latencyMs: Date.now() - callT0, result: J({ error: err.slice(0, 500) }) } }).catch((e) => {
            console.warn(`[agent] AgentToolCall persist failed (run ${runId}, step ${step.id}, tool ${toolName}): ${String(e).slice(0, 200)}`);
          });
        }
        if (!isRetryableError(e) || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await finalize("needs_review", { termination: "policy-blocked", tool: toolName, ...(resumed ? { resumed: true } : { iterations: iter, error: err.slice(0, 500) }) }, err);
          return lastOutput;
        }
        // Transient: loop continues; the next decision sees the failure and may retry or pivot.
      }
    }
    await finalize("needs_review", { termination: "max-iterations", ...(resumed ? { resumed: true } : { iterations: maxIter, toolCalls: ctx.toolCalls }) });
    return lastOutput;
  } catch (e) {
    if (!resumed && e instanceof BudgetError) {
      await finalize("needs_review", { termination: "budget-exhausted", toolCalls: ctx.toolCalls }, String(e));
    } else if (resumed || (runId && (e as Error)?.message !== undefined)) {
      const current = await db.agentRun.findUnique({ where: { id: runId! } }).catch(() => null);
      if (current?.status === "running") {
        await finalize("failed", resumed ? { termination: "error", resumed: true } : { termination: "error" }, String(e));
      }
    }
    throw e;
  }
}

export async function runAgent(
  type: string, input: Record<string, unknown>, ids: { campaignId?: string; leadId?: string },
  opts?: RunOpts,
) {
  // Exactly one context per run: the persisted correlationId is the one the
  // executing loop actually uses.
  const ctx = newContext(ids.campaignId, ids.leadId);
  const run = await db.agentRun.create({ data: { type, campaignId: ids.campaignId, leadId: ids.leadId, status: "running", input: J(input), correlationId: ctx.correlationId } }).catch((e) => {
    console.warn(`[agent] AgentRun persist failed (type ${type}): ${String(e).slice(0, 200)}`);
    return null;
  });
  return executeLoop(type, input, ids, {
    ...opts, ctx, runId: run?.id ?? null, history: [], startIndex: 0, resumed: false, lastOutput: null,
  });
}

// Resume a run after worker/process failure: rebuilds history from persisted
// steps + tool calls, then continues the loop without re-executing successes.
export async function resumeRun(runId: string, opts?: RunOpts & { type?: string; input?: Record<string, unknown>; ids?: { campaignId?: string; leadId?: string } }) {
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("run not found");
  if (run.status === "completed") return (run.output as { lastOutput?: unknown } | null)?.lastOutput ?? null;
  const steps = await db.agentStep.findMany({ where: { runId }, orderBy: { index: "asc" }, include: { toolCalls: { orderBy: { createdAt: "asc" } } } });
  const history: HistoryEntry[] = [];
  for (const s of steps) {
    for (const c of s.toolCalls) {
      const ok = c.status === "ok";
      const entry: HistoryEntry = { tool: c.tool, ok, summary: summarizeResult(c.result) };
      if (ok) (entry as unknown as { rawArgs?: string }).rawArgs = JSON.stringify(c.args);
      history.push(entry);
    }
  }
  return runAgentWithHistory(
    opts?.type ?? run.type,
    (opts?.input ?? run.input ?? {}) as Record<string, unknown>,
    { campaignId: opts?.ids?.campaignId ?? run.campaignId ?? undefined, leadId: opts?.ids?.leadId ?? run.leadId ?? undefined },
    { ...opts, preHistory: history, resumeRunId: runId },
  );
}

async function runAgentWithHistory(
  type: string, input: Record<string, unknown>, ids: { campaignId?: string; leadId?: string },
  opts?: RunOpts & { preHistory?: HistoryEntry[]; resumeRunId?: string },
) {
  // Replays persisted history so repeat/idempotency guards hold, then continues
  // the shared loop without re-executing successes.
  const pre = opts?.preHistory ?? [];
  if (!pre.length || !opts?.resumeRunId) {
    return runAgent(type, input, ids, opts);
  }
  const runId = opts.resumeRunId;
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("run not found");
  await db.agentRun.update({ where: { id: runId }, data: { status: "running", error: null } }).catch((e) => {
    console.warn(`[agent] resume status reset failed (run ${runId}): ${String(e).slice(0, 200)}`);
  });
  const history: HistoryEntry[] = pre.map((h) => ({ ...h }));
  // preHistory arrives from resumeRun with rawArgs already attached for every
  // successful call, so no second recovery pass is needed here. (A previous
  // version re-attached by first-match, which could mis-attach when the same
  // tool ran twice with different args — removed.)
  const steps = await db.agentStep.findMany({ where: { runId }, orderBy: { index: "asc" }, include: { toolCalls: { orderBy: { createdAt: "asc" } } } });
  // Resume continues the consumed budget — it must not grant a fresh window:
  // tool calls are counted exactly from persisted AgentToolCall rows (one row
  // per execution attempt, so no double-counting), steps from AgentStep rows
  // plus one for the terminal iteration unless it persisted a step itself
  // (policy-blocked and max-iterations always do; budget-exhausted from the
  // post-increment site does too, and counting it twice there errs toward
  // stricter budgets), and elapsed wall-clock from the original run creation.
  // Load failures here are fatal: without trustworthy accounting the loop must
  // not continue. (Write failures stay non-fatal per Fix 3.) consecutiveErrors
  // restarts at zero per segment by design.
  const toolCallsConsumed = await db.agentToolCall.count({ where: { step: { runId } } });
  const termination = (run.output as { termination?: string } | null)?.termination;
  const terminalPersistedStep = termination === "policy-blocked" || termination === "max-iterations";
  const base = newContext(ids.campaignId, ids.leadId);
  const resumedCtx: AgentContext = {
    ...base,
    steps: steps.length + (terminalPersistedStep ? 0 : 1),
    toolCalls: toolCallsConsumed,
    startedAt: run.createdAt.getTime(),
    // Same correlation across segments: the resumed loop is traceable as one run.
    correlationId: run.correlationId ?? base.correlationId,
  };
  return executeLoop(type, input, ids, {
    ...opts,
    ctx: resumedCtx,
    runId,
    history,
    startIndex: steps.length,
    resumed: true,
    lastOutput: (run.output as { lastOutput?: unknown } | null)?.lastOutput ?? null,
  });
}
