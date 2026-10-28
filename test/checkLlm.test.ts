import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent/llmClient.js", () => ({
  getLlmConfigProblem: vi.fn(),
  describeModel: vi.fn(() => "testprovider/test-model"),
  generateRefactorPatch: vi.fn(),
}));
const llm = await import("../src/agent/llmClient.js");
const { checkLlm } = await import("../src/cli/checkLlm.js");

let info: string[];
let error: string[];
const out = () => ({ info: (m: string) => info.push(m), error: (m: string) => error.push(m) });

beforeEach(() => {
  vi.clearAllMocks();
  info = [];
  error = [];
});

describe("checkLlm", () => {
  it("reports a config problem and makes no call", async () => {
    vi.mocked(llm.getLlmConfigProblem).mockReturnValue("GOOGLE_GENERATIVE_AI_API_KEY is not set");
    expect(await checkLlm("cheap", out())).toBe(false);
    expect(error.join("\n")).toContain("GOOGLE_GENERATIVE_AI_API_KEY is not set");
    expect(error.join("\n")).toContain("Settings were looked for in:");
    expect(llm.generateRefactorPatch).not.toHaveBeenCalled();
  });

  it("reports success, naming the model, the tier, and what the model answered", async () => {
    vi.mocked(llm.getLlmConfigProblem).mockReturnValue(undefined);
    vi.mocked(llm.generateRefactorPatch).mockResolvedValue({ tool: "abort_task", payload: { reason: "x" } });
    expect(await checkLlm("capable", out())).toBe(true);
    expect(info.join("\n")).toContain("testprovider/test-model");
    expect(info.join("\n")).toContain("capable tier");
    expect(info.join("\n")).toContain('answered with "abort_task"');
    expect(vi.mocked(llm.generateRefactorPatch).mock.calls[0][1]).toBe("capable");
  });

  it("shows retry waits and token usage reported during the call", async () => {
    vi.mocked(llm.getLlmConfigProblem).mockReturnValue(undefined);
    vi.mocked(llm.generateRefactorPatch).mockImplementation(async (_o, _t, _p, hooks) => {
      hooks?.onRetry?.({ attempt: 1, maxRetries: 5, waitMs: 4000, reason: "rate limited (429): slow down" });
      hooks?.onUsage?.({ promptTokens: 321, completionTokens: 45 });
      return { tool: "abort_task", payload: { reason: "x" } };
    });
    await checkLlm("cheap", out());
    expect(info.join("\n")).toContain("rate limited (429): slow down — waiting 4s (retry 1/5)");
    expect(info.join("\n")).toContain("tokens: 321 in / 45 out");
  });

  it("reports the HTTP status and response body when the call fails", async () => {
    vi.mocked(llm.getLlmConfigProblem).mockReturnValue(undefined);
    vi.mocked(llm.generateRefactorPatch).mockRejectedValue(
      Object.assign(new Error("model not found"), { statusCode: 404, responseBody: '{"error":"no such model"}' }),
    );
    expect(await checkLlm("cheap", out())).toBe(false);
    const errors = error.join("\n");
    expect(errors).toContain("model not found");
    expect(errors).toContain("HTTP status: 404");
    expect(errors).toContain("no such model");
  });
});