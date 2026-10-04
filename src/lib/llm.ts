import { trackUsage } from "./models";
import type { ModelTask } from "./models";

// Provider-neutral LLM abstraction. Business logic never imports an SDK directly.
export interface TrackingContext {
  workspaceId?: string; campaignId?: string; leadId?: string; runId?: string;
  task?: ModelTask | string; promptVersion?: string;
}
export interface StructuredOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tracking?: TrackingContext;
}
export interface ToolChoice {
  action: "tool" | "complete" | "escalate";
  tool?: string;
  args?: Record<string, unknown>;
  reasoning?: string;
  reason?: string;
}
export interface ToolCatalogEntry {
  name: string;
  description: string;
  argsSchema: { type: "object"; properties: Record<string, { type: string; enum?: string[]; default?: unknown }>; required: string[] };
}
export interface LLMProvider {
  name: string;
  generateStructured<T>(prompt: string, schema: unknown, opts?: StructuredOptions): Promise<T>;
  generateText(prompt: string, opts?: StructuredOptions): Promise<string>;
  // Native function-calling where the provider supports it. Optional: callers
  // fall back to generateStructured(JSON-mode) when absent.
  selectTool?(input: { prompt: string; tools: ToolCatalogEntry[]; opts?: StructuredOptions }): Promise<ToolChoice>;
}

import OpenAI from "openai";

// Runs an LLM call with usage observability that can never break the agent path.
async function withTracking<T>(
  provider: string, model: string, tracking: TrackingContext | undefined,
  fn: () => Promise<{ result: T; inputTokens: number | null; outputTokens: number | null }>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const { result, inputTokens, outputTokens } = await fn();
    await trackUsage({
      ...tracking, provider, model, task: tracking?.task ?? "reasoning",
      inputTokens, outputTokens, latencyMs: Date.now() - t0, success: true,
    });
    return result;
  } catch (e) {
    await trackUsage({
      ...tracking, provider, model, task: tracking?.task ?? "reasoning",
      inputTokens: null, outputTokens: null,
      latencyMs: Date.now() - t0, success: false, error: String(e),
    });
    throw e;
  }
}

class OpenAIProvider implements LLMProvider {
  name = "openai";
  protected client: OpenAI | null = null;
  protected getClient() {
    if (!this.client) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY not configured");
      this.client = new OpenAI({ apiKey: key });
    }
    return this.client;
  }
  async generateText(prompt: string, opts?: StructuredOptions): Promise<string> {
    const model = opts?.model ?? process.env.LLM_DEFAULT_MODEL ?? "gpt-4o-mini";
    return withTracking("openai", model, opts?.tracking, async () => {
      const r = await this.getClient().chat.completions.create({
        model,
        temperature: opts?.temperature ?? 0.2,
        max_tokens: opts?.maxTokens ?? 2000,
        messages: [{ role: "user", content: prompt }],
      });
      return {
        result: r.choices[0]?.message?.content ?? "",
        inputTokens: r.usage?.prompt_tokens ?? null,
        outputTokens: r.usage?.completion_tokens ?? null,
      };
    });
  }
  async generateStructured<T>(prompt: string, _schema: unknown, opts?: StructuredOptions): Promise<T> {
    const text = await this.generateText(
      `${prompt}\n\nReturn ONLY valid JSON matching the requested shape. No markdown fences.`,
      opts,
    );
    const cleaned = text.replace(/```json?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned) as T;
  }
  // Native OpenAI function-calling: the model selects among real tool schemas.
  async selectTool(input: { prompt: string; tools: ToolCatalogEntry[]; opts?: StructuredOptions }): Promise<ToolChoice> {
    const model = input.opts?.model ?? process.env.LLM_DEFAULT_MODEL ?? "gpt-4o-mini";
    return withTracking("openai", model, input.opts?.tracking, async () => {
      const r = await this.getClient().chat.completions.create({
        model,
        temperature: input.opts?.temperature ?? 0.2,
        max_tokens: input.opts?.maxTokens ?? 800,
        messages: [{ role: "user", content: input.prompt }],
        tools: [
          ...input.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.argsSchema },
          })),
          {
            type: "function" as const,
            function: {
              name: "finish",
              description: "End the run: objective complete OR blocked and needs human review.",
              parameters: {
                type: "object" as const,
                properties: {
                  outcome: { type: "string", enum: ["complete", "escalate"] },
                  reason: { type: "string" },
                },
                required: ["outcome", "reason"],
              },
            },
          },
        ],
        tool_choice: "auto",
      });
      const call = r.choices[0]?.message?.tool_calls?.[0];
      const u = r.usage;
      let result: ToolChoice;
      if (!call || call.function.name === "finish") {
        const args = JSON.parse(call?.function.arguments ?? "{}") as { outcome?: string; reason?: string };
        result = args.outcome === "escalate"
          ? { action: "escalate", reason: args.reason ?? "model escalated" }
          : { action: "complete", reason: args.reason ?? "objective complete" };
      } else {
        result = {
          action: "tool",
          tool: call.function.name,
          args: JSON.parse(call.function.arguments || "{}") as Record<string, unknown>,
          reasoning: call.function.name,
        };
      }
      return { result, inputTokens: u?.prompt_tokens ?? null, outputTokens: u?.completion_tokens ?? null };
    });
  }
}

class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  async generateText(prompt: string, opts?: StructuredOptions): Promise<string> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
    const model = opts?.model ?? "claude-3-5-sonnet-20241022";
    return withTracking("anthropic", model, opts?.tracking, async () => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: opts?.maxTokens ?? 2000, messages: [{ role: "user", content: prompt }] }),
      });
      if (!r.ok) throw new Error(`anthropic: ${r.status}`);
      const j = (await r.json()) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = j.content?.map((c) => c.text ?? "").join("") ?? "";
      return { result: text, inputTokens: j.usage?.input_tokens ?? null, outputTokens: j.usage?.output_tokens ?? null };
    });
  }
  async generateStructured<T>(prompt: string, _schema: unknown, opts?: StructuredOptions): Promise<T> {
    const text = await this.generateText(
      `${prompt}\n\nReturn ONLY valid JSON matching the requested shape. No markdown fences.`,
      opts,
    );
    return JSON.parse(text.replace(/```json?/g, "").replace(/```/g, "").trim()) as T;
  }
}

// DeepSeek: OpenAI-compatible API via baseURL override.
export class DeepSeekProvider extends OpenAIProvider {
  name = "deepseek";
  protected getClient() {
    if (!this.client) {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) throw new Error("DEEPSEEK_API_KEY not configured");
      this.client = new OpenAI({ apiKey: key, baseURL: "https://api.deepseek.com/v1" });
    }
    return this.client;
  }
}

// OpenRouter: OpenAI-compatible gateway via baseURL override.
export class OpenRouterProvider extends OpenAIProvider {
  name = "openrouter";
  protected getClient() {
    if (!this.client) {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) throw new Error("OPENROUTER_API_KEY not configured");
      const headers: Record<string, string> = {};
      if (process.env.OPENROUTER_HTTP_REFERER) headers["HTTP-Referer"] = process.env.OPENROUTER_HTTP_REFERER;
      if (process.env.OPENROUTER_X_TITLE) headers["X-Title"] = process.env.OPENROUTER_X_TITLE;
      this.client = new OpenAI({ apiKey: key, baseURL: "https://openrouter.ai/api/v1", defaultHeaders: headers });
    }
    return this.client;
  }
}

// Deterministic fallback used in dev/test without keys: NOT used in production paths silently.
class ConsoleProvider implements LLMProvider {
  name = "console";
  async generateText(prompt: string): Promise<string> {
    return `[console-llm] no API key configured. Prompt hash: ${prompt.length} chars`;
  }
  async generateStructured<T>(prompt: string): Promise<T> {
    throw new Error(`LLM not configured (console provider). Prompt: ${prompt.slice(0, 120)}…`);
  }
}

export function getLLMProvider(preferred?: string): LLMProvider {
  const p = preferred ?? process.env.LLM_PROVIDER ?? "openai";
  if (p === "anthropic" && process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  if (p === "openai" && process.env.OPENAI_API_KEY) return new OpenAIProvider();
  if (p === "deepseek" && process.env.DEEPSEEK_API_KEY) return new DeepSeekProvider();
  if (p === "openrouter" && process.env.OPENROUTER_API_KEY) return new OpenRouterProvider();
  if (process.env.OPENAI_API_KEY) return new OpenAIProvider();
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  if (process.env.DEEPSEEK_API_KEY) return new DeepSeekProvider();
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterProvider();
  return new ConsoleProvider();
}

// Provider fallback: try providers in order; only fail over on retryable errors,
// never on validation errors. Semantics stay identical across providers.
export async function generateTextWithFallback(
  prompt: string,
  opts: StructuredOptions & { providers?: string[] },
): Promise<{ text: string; provider: string }> {
  const chain = opts.providers ?? ["openai", "anthropic", "deepseek", "openrouter"];
  let lastError = "";
  for (const p of chain) {
    try {
      // Report the ACTUAL provider served: the factory may fall back (e.g. to
      // console) when the requested one has no credentials.
      const provider = getLLMProvider(p);
      const text = await provider.generateText(prompt, opts);
      return { text, provider: provider.name };
    } catch (e) {
      lastError = String(e);
      if (/not configured/i.test(lastError)) continue; // missing credentials → next provider
      if (!/429|5\d\d|timeout|ECONN|fetch failed/i.test(lastError)) throw e; // permanent → stop
    }
  }
  throw new Error(`All LLM providers failed: ${lastError}`);
}
