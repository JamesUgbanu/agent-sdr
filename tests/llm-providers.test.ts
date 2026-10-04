import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the OpenAI SDK so we can inspect client configuration without real API calls.
const mockState = vi.hoisted(() => ({
  lastConfig: null as Record<string, unknown> | null,
  chatResponse: { choices: [{ message: { content: "mock response" } }], usage: { prompt_tokens: 10, output_tokens: 5 } },
}));
vi.mock("openai", () => ({
  default: class MockOpenAI {
    config: Record<string, unknown>;
    chat: { completions: { create: (args: unknown) => Promise<unknown> } };
    constructor(config: Record<string, unknown>) {
      this.config = config;
      mockState.lastConfig = config;
      this.chat = {
        completions: {
          create: async () => mockState.chatResponse,
        },
      };
    }
  },
}));

import { getLLMProvider, generateTextWithFallback, DeepSeekProvider, OpenRouterProvider } from "../src/lib/llm";

describe("DeepSeek provider", () => {
  beforeEach(() => {
    mockState.lastConfig = null;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_HTTP_REFERER;
    delete process.env.OPENROUTER_X_TITLE;
  });
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_HTTP_REFERER;
    delete process.env.OPENROUTER_X_TITLE;
  });

  it("returns DeepSeekProvider when DEEPSEEK_API_KEY is set", () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const p = getLLMProvider("deepseek");
    expect(p.name).toBe("deepseek");
  });

  it("falls back to ConsoleProvider when DEEPSEEK_API_KEY is missing", () => {
    const p = getLLMProvider("deepseek");
    expect(p.name).toBe("console");
  });

  it("throws explicit error when generateText is called without key", async () => {
    const p = new DeepSeekProvider();
    await expect(p.generateText("hello")).rejects.toThrow(/DEEPSEEK_API_KEY not configured/);
  });

  it("uses the correct DeepSeek base URL", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const p = getLLMProvider("deepseek");
    await p.generateText("hello");
    expect(mockState.lastConfig?.baseURL).toBe("https://api.deepseek.com/v1");
    expect(mockState.lastConfig?.apiKey).toBe("test-deepseek-key");
  });

  it("inherits native tool-calling (selectTool)", () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const p = getLLMProvider("deepseek");
    expect(typeof p.selectTool).toBe("function");
  });

  it("generateText works and returns content", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const p = getLLMProvider("deepseek");
    const text = await p.generateText("hello");
    expect(text).toBe("mock response");
  });
});

describe("OpenRouter provider", () => {
  beforeEach(() => {
    mockState.lastConfig = null;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_HTTP_REFERER;
    delete process.env.OPENROUTER_X_TITLE;
  });
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_HTTP_REFERER;
    delete process.env.OPENROUTER_X_TITLE;
  });

  it("returns OpenRouterProvider when OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const p = getLLMProvider("openrouter");
    expect(p.name).toBe("openrouter");
  });

  it("falls back to ConsoleProvider when OPENROUTER_API_KEY is missing", () => {
    const p = getLLMProvider("openrouter");
    expect(p.name).toBe("console");
  });

  it("throws explicit error when generateText is called without key", async () => {
    const p = new OpenRouterProvider();
    await expect(p.generateText("hello")).rejects.toThrow(/OPENROUTER_API_KEY not configured/);
  });

  it("uses the correct OpenRouter base URL", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const p = getLLMProvider("openrouter");
    await p.generateText("hello");
    expect(mockState.lastConfig?.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(mockState.lastConfig?.apiKey).toBe("test-openrouter-key");
  });

  it("applies optional HTTP-Referer and X-Title headers when configured", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.OPENROUTER_HTTP_REFERER = "https://myapp.com";
    process.env.OPENROUTER_X_TITLE = "My App";
    const p = getLLMProvider("openrouter");
    await p.generateText("hello");
    expect(mockState.lastConfig?.defaultHeaders).toMatchObject({
      "HTTP-Referer": "https://myapp.com",
      "X-Title": "My App",
    });
  });

  it("omits optional headers when not configured", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const p = getLLMProvider("openrouter");
    await p.generateText("hello");
    const headers = (mockState.lastConfig?.defaultHeaders ?? {}) as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(headers["X-Title"]).toBeUndefined();
  });

  it("inherits native tool-calling (selectTool)", () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const p = getLLMProvider("openrouter");
    expect(typeof p.selectTool).toBe("function");
  });
});

describe("fallback chain", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("uses the first provider in the chain that has a key", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const r = await generateTextWithFallback("hello", { providers: ["deepseek", "openrouter"] });
    expect(r.provider).toBe("deepseek");
  });

  it("returns deepseek result when deepseek is the only configured provider", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const r = await generateTextWithFallback("hello", { providers: ["deepseek"] });
    expect(r.provider).toBe("deepseek");
    expect(r.text).toBe("mock response");
  });

  it("returns console output when no provider in the chain has a key", async () => {
    const r = await generateTextWithFallback("hello", { providers: ["openai"] });
    // Reports the ACTUAL provider served (console fallback), not the requested name.
    expect(r.provider).toBe("console");
    expect(r.text).toContain("console-llm");
  });
});
