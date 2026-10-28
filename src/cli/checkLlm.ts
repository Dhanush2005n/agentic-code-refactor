/**
 * `autorefactor check-llm`: makes ONE small call with the user's current
 * settings and reports exactly what happened — so "my key/model/network is
 * wrong" can be told apart from "the pipeline is wrong" before any file is
 * touched. Output goes through callbacks so it can be tested.
 */
import { describeModel, generateRefactorPatch, getLlmConfigProblem, type ModelTier } from "../agent/llmClient.js";
import { describeConfigHelp } from "./configHelp.js";

export interface CheckOutput {
  info: (message: string) => void;
  error: (message: string) => void;
}

/** Returns true if the call succeeded. */
export async function checkLlm(tier: ModelTier, out: CheckOutput): Promise<boolean> {
  const problem = getLlmConfigProblem();
  if (problem) {
    out.error(`Config problem: ${problem}`);
    out.error(describeConfigHelp());
    return false;
  }

  out.info(`Calling ${describeModel(tier)} (${tier} tier; this can take a while on a free tier)...`);
  const started = Date.now();
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
  try {
    const result = await generateRefactorPatch(
      {
        taskId: "check",
        targetNodeId: "check::add",
        instruction: "Add explicit parameter and return types.",
        contextSlice: "function add(a, b) {\n  return a + b;\n}",
      },
      tier,
      [],
      {
        onRetry: (r) => out.info(`  ⏳ ${r.reason} — waiting ${Math.ceil(r.waitMs / 1000)}s (retry ${r.attempt}/${r.maxRetries})`),
        onUsage: (u) => out.info(`  tokens: ${u.promptTokens} in / ${u.completionTokens} out`),
      },
    );
    out.info(`OK after ${seconds()}s: the model answered with "${result.tool}".`);
    return true;
  } catch (err) {
    const e = err as Error & { statusCode?: number; responseBody?: string };
    out.error(`FAILED after ${seconds()}s: ${e.message}`);
    if (e.statusCode) out.error(`HTTP status: ${e.statusCode}`);
    if (e.responseBody) out.error(`Response body: ${e.responseBody.slice(0, 800)}`);
    return false;
  }
}