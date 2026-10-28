import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedNode } from "../src/types/ast.types.js";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn((id: string) => ({ provider: "anthropic", modelId: id })) }));
vi.mock("@ai-sdk/openai", () => ({ openai: vi.fn((id: string) => ({ provider: "openai", modelId: id })) }));
vi.mock("@ai-sdk/google", () => ({ google: vi.fn((id: string) => ({ provider: "google", modelId: id })) }));

const { generateObject } = await import("ai");
const { anthropic } = await import("@ai-sdk/anthropic");
const { openai } = await import("@ai-sdk/openai");
const { google } = await import("@ai-sdk/google");

function makeNode(overrides: Partial<Pick<ParsedNode, "complexity" | "smells">>): Pick<ParsedNode, "complexity" | "smells"> {
  return { complexity: 1, smells: [], ...overrides };
}

const ORIGINAL_ENV = { ...process.env };

describe("pickModelTier", () => {
  it("routes a single ordinary smell to the cheap tier", async () => {
    const { pickModelTier } = await import("../src/agent/llmClient.js");
    expect(pickModelTier(makeNode({ complexity: 1, smells: [{ type: "untyped-signature", message: "x", line: 1 }] }))).toBe("cheap");
  });
  it("routes high-complexity to the capable tier", async () => {
    const { pickModelTier } = await import("../src/agent/llmClient.js");
    expect(pickModelTier(makeNode({ complexity: 15, smells: [{ type: "high-complexity", message: "x", line: 1 }] }))).toBe("capable");
  });
  it("routes callback-hell to the capable tier", async () => {
    const { pickModelTier } = await import("../src/agent/llmClient.js");
    expect(pickModelTier(makeNode({ complexity: 4, smells: [{ type: "callback-hell", message: "x", line: 1 }] }))).toBe("capable");
  });
  it("routes to capable once smell count reaches the multi-issue threshold", async () => {
    const { pickModelTier } = await import("../src/agent/llmClient.js");
    expect(pickModelTier(makeNode({ complexity: 1, smells: [{ type: "untyped-signature", message: "x", line: 1 }, { type: "var-usage", message: "y", line: 1 }] }))).toBe("capable");
  });
});

describe("generateRefactorPatch — default provider (anthropic)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    process.env.LLM_RETRY_BASE_MS = "1"; // keep backoff waits tiny under test
    vi.mocked(generateObject).mockReset();
  });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  it("throws a clear error when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await expect(generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "cheap")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("uses Anthropic's built-in default model ids without needing env vars set", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "Add types.", contextSlice: "function f() {}" }, "capable");
    expect(anthropic).toHaveBeenCalledWith(expect.stringContaining("claude"));
    expect(openai).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });

  it("marks the system and initial user messages as cacheable", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "Add types.", contextSlice: "function f() {}" }, "cheap");
    const call = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(call.messages[0].providerOptions.anthropic.cacheControl.type).toBe("ephemeral");
    expect(call.messages[1].providerOptions.anthropic.cacheControl.type).toBe("ephemeral");
  });

  it("appends priorTurns after the cached messages", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const priorTurns = [{ role: "assistant" as const, content: "previous attempt" }, { role: "user" as const, content: "it failed: TS2345" }];
    await generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "Add types.", contextSlice: "function f() {}" }, "cheap", priorTurns);
    const call = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(call.messages).toHaveLength(4);
    expect(call.messages[2].content).toBe("previous attempt");
    expect(call.messages[3].content).toBe("it failed: TS2345");
  });

  const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
  const okResponse = { object: { tool: "abort_task", payload: { reason: "x" } } } as any;
  const apiError = (status: number, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`HTTP ${status}`), { statusCode: status, isRetryable: [408, 409, 429].includes(status) || status >= 500, ...extra });

  it("retries a rate-limited (429) call, tells the caller why, then succeeds — with the SDK's own silent retries off", async () => {
    vi.mocked(generateObject).mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce(okResponse);
    const onRetry = vi.fn();
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");

    const result = await generateRefactorPatch(objective, "cheap", [], { onRetry });

    expect(result).toEqual(okResponse.object);
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0].reason).toContain("429");
    expect(onRetry.mock.calls[0][0].attempt).toBe(1);
    expect((vi.mocked(generateObject).mock.calls[0][0] as any).maxRetries).toBe(0);
  });

  it("reports the API's own token counts through onUsage after a successful call", async () => {
    vi.mocked(generateObject).mockResolvedValue({ ...okResponse, usage: { promptTokens: 321, completionTokens: 45, totalTokens: 366 } });
    const onUsage = vi.fn();
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch(objective, "cheap", [], { onUsage });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 321, completionTokens: 45 });
  });

  it("does not report usage the provider didn't supply (NaN or missing), rather than counting garbage", async () => {
    const onUsage = vi.fn();
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    vi.mocked(generateObject).mockResolvedValueOnce({ ...okResponse, usage: { promptTokens: NaN, completionTokens: NaN, totalTokens: NaN } });
    await generateRefactorPatch(objective, "cheap", [], { onUsage });
    vi.mocked(generateObject).mockResolvedValueOnce(okResponse); // no usage field at all
    await generateRefactorPatch(objective, "cheap", [], { onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("does not report usage for failed attempts, only for the call that succeeded", async () => {
    vi.mocked(generateObject)
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValueOnce({ ...okResponse, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } });
    const onUsage = vi.fn();
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch(objective, "cheap", [], { onUsage });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("makes 1 + 5 = 6 attempts by default before giving up, then rethrows the original error", async () => {
    delete process.env.LLM_API_RETRIES;
    vi.mocked(generateObject).mockRejectedValue(apiError(429));
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await expect(generateRefactorPatch(objective, "cheap")).rejects.toThrow("HTTP 429");
    expect(generateObject).toHaveBeenCalledTimes(6);
  });

  it("honors LLM_API_RETRIES, and treats a blank or invalid value as the default", async () => {
    vi.mocked(generateObject).mockRejectedValue(apiError(503));
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const attemptsFor = async (value: string) => {
      process.env.LLM_API_RETRIES = value;
      vi.mocked(generateObject).mockClear();
      await expect(generateRefactorPatch(objective, "cheap")).rejects.toThrow();
      return vi.mocked(generateObject).mock.calls.length;
    };
    expect(await attemptsFor("0")).toBe(1); // 0 = no retries
    expect(await attemptsFor("2")).toBe(3);
    expect(await attemptsFor("")).toBe(6); // a blank line in .env must not silently disable retries
    expect(await attemptsFor("lots")).toBe(6);
  });

  it("does not retry an error that waiting can't fix, such as a 400", async () => {
    vi.mocked(generateObject).mockRejectedValue(apiError(400));
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await expect(generateRefactorPatch(objective, "cheap")).rejects.toThrow("HTTP 400");
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("waits as long as the server asks: Gemini's retryDelay in the response body", async () => {
    vi.mocked(generateObject)
      .mockRejectedValueOnce(apiError(429, { responseBody: '{"error":{"details":[{"retryDelay":"0.01s"}]}}' }))
      .mockResolvedValueOnce(okResponse);
    const onRetry = vi.fn();
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch(objective, "cheap", [], { onRetry });
    expect(onRetry.mock.calls[0][0].waitMs).toBeCloseTo(10, 5);
  });

  it("waits as long as the server asks: a retry-after header", async () => {
    vi.mocked(generateObject)
      .mockRejectedValueOnce(apiError(429, { responseHeaders: { "retry-after": "0" } }))
      .mockResolvedValueOnce(okResponse);
    const onRetry = vi.fn();
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch(objective, "cheap", [], { onRetry });
    expect(onRetry.mock.calls[0][0].waitMs).toBe(0);
  });

  it("fails immediately, with a clear message, when the model has a free-tier quota of 0", async () => {
    vi.mocked(generateObject).mockRejectedValue(apiError(429, { responseBody: "Quota exceeded for metric: requests, limit: 0, model: some-model" }));
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await expect(generateRefactorPatch(objective, "cheap")).rejects.toThrow(/no free-tier quota/);
    expect(generateObject).toHaveBeenCalledTimes(1); // retrying would only burn time
  });

  it("fails immediately when a DAILY quota is used up", async () => {
    vi.mocked(generateObject).mockRejectedValue(apiError(429, { responseBody: "Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel" }));
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await expect(generateRefactorPatch(objective, "cheap")).rejects.toThrow(/daily quota/);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal so a stuck call can't hang the pipeline forever", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "abort_task", payload: { reason: "x" } } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "cheap");
    expect((vi.mocked(generateObject).mock.calls[0][0] as any).abortSignal).toBeInstanceOf(AbortSignal);
  });

  // A fake model call that never answers until it is aborted — what a stalled server looks like.
  const hangsUntilAborted = (args: any) =>
    new Promise((_, reject) => args.abortSignal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const unavailableApiError = () => apiError(503, { message: "This model is currently experiencing high demand." });

  it("aborts a request that goes silent and retries it, instead of letting it eat the whole budget", async () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = "40";
    vi.mocked(generateObject).mockImplementationOnce(hangsUntilAborted as any).mockResolvedValueOnce(okResponse);
    const onRetry = vi.fn();
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");

    const result = await generateRefactorPatch(objective, "cheap", [], { onRetry });

    expect(result).toEqual(okResponse.object);
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0].reason).toContain("no response after");
  });

  it("gives up with LlmUnavailableError once the overall budget runs out, naming the last real problem", async () => {
    process.env.LLM_TIMEOUT_MS = "60";
    process.env.LLM_RETRY_BASE_MS = "5000"; // would wait 5s between retries if the budget didn't cut it short
    vi.mocked(generateObject).mockRejectedValue(unavailableApiError());
    const { generateRefactorPatch, LlmUnavailableError } = await import("../src/agent/llmClient.js");
    const started = Date.now();

    const failure = await generateRefactorPatch(objective, "cheap").catch((e) => e);

    expect(failure).toBeInstanceOf(LlmUnavailableError);
    expect(failure.message).toContain("did not finish within");
    expect(failure.message).toContain("server error (503)"); // the REAL last problem, not a guess about rate limiting
    expect(failure.message).toContain("LLM_TIMEOUT_MS");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("throws LlmUnavailableError, not a bare API error, when retries are exhausted on a transient failure", async () => {
    process.env.LLM_API_RETRIES = "1";
    vi.mocked(generateObject).mockRejectedValue(unavailableApiError());
    const { generateRefactorPatch, LlmUnavailableError } = await import("../src/agent/llmClient.js");
    const failure = await generateRefactorPatch(objective, "cheap").catch((e) => e);
    expect(failure).toBeInstanceOf(LlmUnavailableError);
    expect(failure.message).toContain("unavailable after 1 retries");
    expect(failure.message).toContain("server error (503)");
  });

  it("treats a dropped connection (fetch failed) as retryable", async () => {
    vi.mocked(generateObject)
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(okResponse);
    const onRetry = vi.fn();
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch(objective, "cheap", [], { onRetry });
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0].reason).toContain("network error");
  });

  describe("falling back from the capable model to the cheap one", () => {
    // The capable (sonnet) model is down; the cheap (haiku) model is healthy.
    const capableDown = (args: any) =>
      String(args.model.modelId).includes("sonnet") ? Promise.reject(unavailableApiError()) : Promise.resolve(okResponse);

    beforeEach(() => {
      process.env.LLM_API_RETRIES = "1";
      vi.mocked(generateObject).mockImplementation(capableDown as any);
    });

    it("uses the cheap model when the capable one stays unavailable, and says so", async () => {
      const onFallback = vi.fn();
      const { generateRefactorPatch } = await import("../src/agent/llmClient.js");

      const result = await generateRefactorPatch(objective, "capable", [], { onFallback });

      expect(result).toEqual(okResponse.object);
      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(onFallback.mock.calls[0][0]).toMatchObject({ from: "capable", to: "cheap" });
      const modelsTried = vi.mocked(generateObject).mock.calls.map((c) => String((c[0] as any).model.modelId));
      expect(modelsTried.some((m) => m.includes("sonnet"))).toBe(true);
      expect(modelsTried[modelsTried.length - 1]).toContain("haiku");
    });

    it("does not fall back when LLM_FALLBACK=off", async () => {
      process.env.LLM_FALLBACK = "off";
      const { generateRefactorPatch, LlmUnavailableError } = await import("../src/agent/llmClient.js");
      await expect(generateRefactorPatch(objective, "capable")).rejects.toBeInstanceOf(LlmUnavailableError);
      expect(vi.mocked(generateObject).mock.calls.every((c) => String((c[0] as any).model.modelId).includes("sonnet"))).toBe(true);
    });

    it("does not fall back from the cheap tier (there is nothing cheaper)", async () => {
      vi.mocked(generateObject).mockRejectedValue(unavailableApiError());
      const onFallback = vi.fn();
      const { generateRefactorPatch, LlmUnavailableError } = await import("../src/agent/llmClient.js");
      await expect(generateRefactorPatch(objective, "cheap", [], { onFallback })).rejects.toBeInstanceOf(LlmUnavailableError);
      expect(onFallback).not.toHaveBeenCalled();
    });

    it("does not fall back when both tiers are the same model", async () => {
      process.env.LLM_MODEL_CHEAP = "same-model";
      process.env.LLM_MODEL_CAPABLE = "same-model";
      vi.mocked(generateObject).mockRejectedValue(unavailableApiError());
      const onFallback = vi.fn();
      const { generateRefactorPatch, LlmUnavailableError } = await import("../src/agent/llmClient.js");
      await expect(generateRefactorPatch(objective, "capable", [], { onFallback })).rejects.toBeInstanceOf(LlmUnavailableError);
      expect(onFallback).not.toHaveBeenCalled();
    });

    it("does not fall back for errors that waiting on another model can't fix, like a bad request", async () => {
      vi.mocked(generateObject).mockRejectedValue(apiError(400));
      const onFallback = vi.fn();
      const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
      await expect(generateRefactorPatch(objective, "capable", [], { onFallback })).rejects.toThrow("HTTP 400");
      expect(onFallback).not.toHaveBeenCalled();
    });
  });

  it("rethrows errors that retrying cannot fix, untouched", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("Quota exceeded"));
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await expect(generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "cheap")).rejects.toThrow("Quota exceeded");
  });

  it("describeModel names the provider and model for a tier", async () => {
    const { describeModel } = await import("../src/agent/llmClient.js");
    expect(describeModel("cheap")).toMatch(/^anthropic\/claude/);
  });

  it("returns the schema-validated object from the SDK response", async () => {
    const fakeResponse = { tool: "abort_task", payload: { reason: "unsafe" } };
    vi.mocked(generateObject).mockResolvedValue({ object: fakeResponse } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const result = await generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "cheap");
    expect(result).toEqual(fakeResponse);
  });
});

describe("generateRefactorPatch — switching providers", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); process.env = { ...ORIGINAL_ENV }; });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  it("routes to OpenAI's SDK when LLM_PROVIDER=openai", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_MODEL_CHEAP = "gpt-test-cheap";
    process.env.LLM_MODEL_CAPABLE = "gpt-test-capable";
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "cheap");
    expect(openai).toHaveBeenCalledWith("gpt-test-cheap");
    expect(anthropic).not.toHaveBeenCalled();
  });

  it("routes to Google's SDK when LLM_PROVIDER=google", async () => {
    process.env.LLM_PROVIDER = "google";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    process.env.LLM_MODEL_CHEAP = "gemini-test-cheap";
    process.env.LLM_MODEL_CAPABLE = "gemini-test-capable";
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "capable");
    expect(google).toHaveBeenCalledWith("gemini-test-capable");
  });

  it("throws a clear error for a non-Anthropic provider with no model id configured", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await expect(generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "cheap")).rejects.toThrow(/LLM_MODEL_CHEAP/);
  });

  it("requires OPENAI_API_KEY specifically when provider is openai", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL_CHEAP = "gpt-test-cheap";
    process.env.ANTHROPIC_API_KEY = "irrelevant-should-not-satisfy-this";
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await expect(generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "cheap")).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("does NOT attach Anthropic-specific cacheControl when using a different provider", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_MODEL_CHEAP = "gpt-test-cheap";
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    await generateRefactorPatch({ taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" }, "cheap");
    const call = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(call.messages[0].providerOptions).toBeUndefined();
  });

  it("getLlmConfigProblem reports a missing API key for the default provider", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    const { getLlmConfigProblem } = await import("../src/agent/llmClient.js");
    expect(getLlmConfigProblem()).toContain("ANTHROPIC_API_KEY");
  });

  it("getLlmConfigProblem returns undefined when anthropic is fully configured", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { getLlmConfigProblem } = await import("../src/agent/llmClient.js");
    expect(getLlmConfigProblem()).toBeUndefined();
  });

  it("getLlmConfigProblem reports missing model ids for a non-anthropic provider", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.LLM_MODEL_CHEAP;
    const { getLlmConfigProblem } = await import("../src/agent/llmClient.js");
    expect(getLlmConfigProblem()).toContain("LLM_MODEL_CHEAP");
  });

  it("getLlmConfigProblem rejects an unrecognized LLM_PROVIDER instead of silently using anthropic", async () => {
    process.env.LLM_PROVIDER = "gemini";
    const { getLlmConfigProblem } = await import("../src/agent/llmClient.js");
    expect(getLlmConfigProblem()).toContain("LLM_PROVIDER");
  });
});