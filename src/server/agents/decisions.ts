import type { ToolChoice } from "@/lib/llm";
import { tools, toolCatalog } from "../tools/registry";
import type { StateSnapshot } from "./state";

export class DecisionError extends Error {}

export function validateDecision(raw: ToolChoice, allowed: string[]): { tool: string; args: Record<string, unknown>; reasoning: string } {
  if (!raw || raw.action !== "tool") throw new DecisionError("decision is not a tool call");
  if (!raw.tool || !allowed.includes(raw.tool) || !tools[raw.tool]) {
    throw new DecisionError(`tool ${String(raw.tool)} is not permitted for this run`);
  }
  const parsed = tools[raw.tool]!.schema.safeParse(raw.args ?? {});
  if (!parsed.success) throw new DecisionError(`invalid args for ${raw.tool}: ${parsed.error.message}`);
  return { tool: raw.tool, args: parsed.data as Record<string, unknown>, reasoning: raw.reasoning ?? "" };
}

function decisionPrompt(snap: StateSnapshot, allowed: string[]): string {
  const catalog = toolCatalog(allowed);
  return [
    "You are the SDR orchestrator. Observe the state and history, then choose the single next action.",
    `RUN_TYPE: ${snap.runType}`,
    `OBJECTIVE: ${snap.objective}`,
    `STATE_JSON: ${JSON.stringify({ lead: snap.lead ?? null, campaign: snap.campaign ?? null, contactable: snap.contactable ?? null, sequence: snap.sequence ?? null, pendingApprovals: snap.pendingApprovals ?? 0, recentMessages: snap.recentMessages ?? [] })}`,
    `ALLOWED_TOOLS (use EXACTLY these names): ${JSON.stringify(catalog)}`,
    `HISTORY_JSON (most recent last): ${JSON.stringify(snap.history)}`,
    "Rules: return ONLY JSON {action: 'tool'|'complete'|'escalate', tool?, args?, reasoning?, reason?}.",
    "Choose a tool only if it can advance the objective given the state above.",
    "Use args fields exactly as listed; never invent emails, prices, times, or facts.",
    "Choose complete when the objective is met or no useful tool remains.",
    "Choose escalate when blocked by policy, missing data, or repeated failure.",
  ].join("\n");
}

// Genuine LLM-driven next-tool selection: native function-calling where the
// provider supports it, validated JSON-mode otherwise. Every returned call is
// validated against the registry (name + args schema) before execution.
export async function decideNextAction(
  snap: StateSnapshot, allowed: string[],
  tracking?: { workspaceId?: string; campaignId?: string; leadId?: string; runId?: string },
  correction?: string,
): Promise<ToolChoice> {
  const { getLLMProvider } = await import("@/lib/llm");
  const { resolveModel } = await import("@/lib/models");
  const mc = await resolveModel("reasoning", tracking?.workspaceId);
  const llm = getLLMProvider(mc.provider);
  let prompt = decisionPrompt(snap, allowed);
  if (correction) {
    prompt += `\nCORRECTION: your previous response was rejected: ${correction}. Fix it and respond with valid JSON only.`;
  }
  const opts = { model: mc.model, temperature: 0, maxTokens: 800, tracking: { ...tracking, task: "reasoning" as const } };
  if (llm.selectTool) {
    const choice = await llm.selectTool({ prompt, tools: toolCatalog(allowed), opts });
    if (choice.action === "tool") validateDecision(choice, allowed); // throws DecisionError on any violation
    return choice;
  }
  const raw = await llm.generateStructured<ToolChoice>(prompt, null, opts);
  if (raw.action === "tool") validateDecision(raw, allowed);
  if (raw.action !== "tool" && raw.action !== "complete" && raw.action !== "escalate") {
    throw new DecisionError(`unknown action ${String((raw as { action?: unknown }).action)}`);
  }
  return raw;
}

// Deterministic fallback used ONLY when no LLM provider is configured
// (dev/test/staging without keys). State-driven, never a blind replay: it picks
// the first permitted tool that has not yet succeeded in this run and whose
// schema the current input satisfies, and stops after errors.
export function fallbackDecide(
  snap: StateSnapshot, allowed: string[], input: Record<string, unknown>,
): ToolChoice {
  const last = snap.history[snap.history.length - 1];
  if (last && !last.ok) return { action: "escalate", reason: `previous tool ${last.tool} failed; no LLM available to replan` };
  const succeeded = new Set(snap.history.filter((h) => h.ok).map((h) => h.tool));
  for (const name of allowed) {
    const tool = tools[name];
    if (!tool || succeeded.has(name)) continue;
    if (tool.schema.safeParse({ ...input }).success) {
      return { action: "tool", tool: name, args: { ...input }, reasoning: "deterministic fallback: first untried applicable tool" };
    }
  }
  return { action: "complete", reason: "no further applicable tools" };
}
